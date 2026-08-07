// AVFoundation single-frame decoder bridge (macOS).
//
// Exposes a persistent, hardware-accelerated frame extractor over a plain C ABI
// so the Rust decode layer can pull any frame at any time cheaply. The
// AVAssetImageGenerator is created once per media file and reused across seeks
// (kept "warm"), which is what makes arbitrary-frame scrubbing near-instant —
// AVFoundation handles keyframe indexing + seek + hardware decode internally.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>

typedef struct {
    void *gen; // retained AVAssetImageGenerator (CFBridgingRetain)
} SeAvDecoder;

// Open a decoder for `path`, capping the long edge to `max_dim` (0 = full size).
// `tolerance_ms` controls the seek tolerance: 0 = frame-accurate (precise but
// slower, for parking on release); >0 = allow the decoder to return a nearby
// frame quickly (much faster, for smooth dragging). Returns NULL on failure.
void *se_av_open(const char *path, int max_dim, int tolerance_ms) {
    @autoreleasepool {
        if (!path) return NULL;
        NSString *p = [NSString stringWithUTF8String:path];
        NSURL *url = [NSURL fileURLWithPath:p];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        if (!asset) return NULL;
        // Must actually carry a video track.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        NSUInteger videoTracks = [[asset tracksWithMediaType:AVMediaTypeVideo] count];
#pragma clang diagnostic pop
        if (videoTracks == 0) return NULL;

        AVAssetImageGenerator *gen =
            [[AVAssetImageGenerator alloc] initWithAsset:asset];
        gen.appliesPreferredTrackTransform = YES; // respect rotation metadata
        if (tolerance_ms <= 0) {
            gen.requestedTimeToleranceBefore = kCMTimeZero;
            gen.requestedTimeToleranceAfter = kCMTimeZero;
        } else {
            CMTime tol = CMTimeMake(tolerance_ms, 1000);
            gen.requestedTimeToleranceBefore = tol;
            gen.requestedTimeToleranceAfter = tol;
        }
        if (max_dim > 0) {
            gen.maximumSize = CGSizeMake((CGFloat)max_dim, (CGFloat)max_dim);
        }

        SeAvDecoder *d = (SeAvDecoder *)malloc(sizeof(SeAvDecoder));
        d->gen = (void *)CFBridgingRetain(gen);
        return d;
    }
}

// Decode the frame at `t` seconds into a freshly malloc'd RGBA8 buffer.
// Returns 1 on success (caller frees *out_rgba via se_av_free), 0 on failure.
int se_av_frame(void *handle, double t, uint8_t **out_rgba, int *out_w, int *out_h) {
    if (!handle || !out_rgba) return 0;
    @autoreleasepool {
        SeAvDecoder *d = (SeAvDecoder *)handle;
        AVAssetImageGenerator *gen = (__bridge AVAssetImageGenerator *)d->gen;
        if (!gen) return 0;

        CMTime time = CMTimeMakeWithSeconds(t, 600);
        NSError *err = nil;
        // Synchronous still extraction on this worker thread. The async variant
        // exists but the sync call is simplest here and fully supported.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        CGImageRef img = [gen copyCGImageAtTime:time actualTime:NULL error:&err];
#pragma clang diagnostic pop
        if (!img) return 0;

        size_t w = CGImageGetWidth(img);
        size_t h = CGImageGetHeight(img);
        if (w == 0 || h == 0) {
            CGImageRelease(img);
            return 0;
        }
        size_t bytesPerRow = w * 4;
        uint8_t *buf = (uint8_t *)malloc(h * bytesPerRow);
        if (!buf) {
            CGImageRelease(img);
            return 0;
        }
        CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
        CGContextRef ctx = CGBitmapContextCreate(
            buf, w, h, 8, bytesPerRow, cs,
            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
        CGColorSpaceRelease(cs);
        if (!ctx) {
            free(buf);
            CGImageRelease(img);
            return 0;
        }
        CGContextDrawImage(ctx, CGRectMake(0, 0, (CGFloat)w, (CGFloat)h), img);
        CGContextRelease(ctx);
        CGImageRelease(img);

        *out_rgba = buf;
        *out_w = (int)w;
        *out_h = (int)h;
        return 1;
    }
}

void se_av_free(uint8_t *buf) {
    if (buf) free(buf);
}

// ---- Sequential reader (AVAssetReader) ------------------------------------
//
// AVAssetImageGenerator re-seeks on every call (~24fps ceiling). For scrubbing
// that should feel like playback we instead stream frames sequentially from a
// start time with AVAssetReader, which decodes forward at a few ms/frame. The
// scrub layer reads forward to follow the cursor and reopens on backward jumps.

typedef struct {
    void *reader; // retained AVAssetReader
    void *output; // retained AVAssetReaderTrackOutput
} SeAvReader;

void *se_av_reader_open(const char *path, double start, int max_dim) {
    @autoreleasepool {
        if (!path) return NULL;
        NSString *p = [NSString stringWithUTF8String:path];
        NSURL *url = [NSURL fileURLWithPath:p];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        if (!asset) return NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        NSArray *vtracks = [asset tracksWithMediaType:AVMediaTypeVideo];
#pragma clang diagnostic pop
        if ([vtracks count] == 0) return NULL;
        AVAssetTrack *track = (AVAssetTrack *)[vtracks objectAtIndex:0];

        NSError *err = nil;
        AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&err];
        if (!reader) return NULL;
        CMTime st = CMTimeMakeWithSeconds(start < 0 ? 0 : start, 600);
        reader.timeRange = CMTimeRangeMake(st, kCMTimePositiveInfinity);

        // Target size preserving aspect (hardware scales during read).
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        CGSize ns = track.naturalSize;
#pragma clang diagnostic pop
        int outW = (int)ns.width, outH = (int)ns.height;
        if (max_dim > 0) {
            CGFloat lng = ns.width > ns.height ? ns.width : ns.height;
            if (lng > (CGFloat)max_dim) {
                CGFloat s = (CGFloat)max_dim / lng;
                outW = ((int)(ns.width * s) / 2) * 2;
                outH = ((int)(ns.height * s) / 2) * 2;
            }
        }
        if (outW < 2) outW = 2;
        if (outH < 2) outH = 2;

        NSDictionary *settings = @{
            (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
            (id)kCVPixelBufferWidthKey : @(outW),
            (id)kCVPixelBufferHeightKey : @(outH),
        };
        AVAssetReaderTrackOutput *out =
            [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:settings];
        out.alwaysCopiesSampleData = NO;
        if (![reader canAddOutput:out]) return NULL;
        [reader addOutput:out];
        if (![reader startReading]) return NULL;

        SeAvReader *r = (SeAvReader *)malloc(sizeof(SeAvReader));
        r->reader = (void *)CFBridgingRetain(reader);
        r->output = (void *)CFBridgingRetain(out);
        return r;
    }
}

int se_av_reader_next(void *handle, uint8_t **out_rgba, int *out_w, int *out_h, double *out_time) {
    if (!handle || !out_rgba) return 0;
    @autoreleasepool {
        SeAvReader *r = (SeAvReader *)handle;
        AVAssetReader *reader = (__bridge AVAssetReader *)r->reader;
        AVAssetReaderTrackOutput *out = (__bridge AVAssetReaderTrackOutput *)r->output;
        if (reader.status != AVAssetReaderStatusReading) return 0;

        CMSampleBufferRef sb = [out copyNextSampleBuffer];
        if (!sb) return 0;
        CMTime pts = CMSampleBufferGetPresentationTimeStamp(sb);
        CVImageBufferRef px = CMSampleBufferGetImageBuffer(sb);
        if (!px) {
            CFRelease(sb);
            return 0;
        }
        CVPixelBufferLockBaseAddress(px, kCVPixelBufferLock_ReadOnly);
        size_t w = CVPixelBufferGetWidth(px);
        size_t h = CVPixelBufferGetHeight(px);
        size_t srcStride = CVPixelBufferGetBytesPerRow(px);
        uint8_t *src = (uint8_t *)CVPixelBufferGetBaseAddress(px);
        uint8_t *buf = (uint8_t *)malloc(w * h * 4);
        if (buf && src) {
            // BGRA (hardware) -> RGBA (what the compositor expects).
            for (size_t y = 0; y < h; y++) {
                uint8_t *srow = src + y * srcStride;
                uint8_t *drow = buf + y * w * 4;
                for (size_t x = 0; x < w; x++) {
                    drow[x * 4 + 0] = srow[x * 4 + 2];
                    drow[x * 4 + 1] = srow[x * 4 + 1];
                    drow[x * 4 + 2] = srow[x * 4 + 0];
                    drow[x * 4 + 3] = srow[x * 4 + 3];
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(px, kCVPixelBufferLock_ReadOnly);
        CFRelease(sb);
        if (!buf) return 0;

        *out_rgba = buf;
        *out_w = (int)w;
        *out_h = (int)h;
        *out_time = CMTimeGetSeconds(pts);
        return 1;
    }
}

void se_av_reader_close(void *handle) {
    if (!handle) return;
    SeAvReader *r = (SeAvReader *)handle;
    if (r->output) CFRelease(r->output);
    if (r->reader) CFRelease(r->reader);
    free(r);
}

void se_av_close(void *handle) {
    if (!handle) return;
    SeAvDecoder *d = (SeAvDecoder *)handle;
    if (d->gen) CFRelease(d->gen); // balances CFBridgingRetain
    free(d);
}
