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
// Returns NULL on failure.
void *se_av_open(const char *path, int max_dim) {
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
        // Frame-accurate: land exactly on the requested time.
        gen.requestedTimeToleranceBefore = kCMTimeZero;
        gen.requestedTimeToleranceAfter = kCMTimeZero;
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

void se_av_close(void *handle) {
    if (!handle) return;
    SeAvDecoder *d = (SeAvDecoder *)handle;
    if (d->gen) CFRelease(d->gen); // balances CFBridgingRetain
    free(d);
}
