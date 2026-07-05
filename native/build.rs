fn main() {
    // On macOS, compile the AVFoundation single-frame decoder bridge and link
    // the Apple frameworks it uses. Other platforms rely on the FFmpeg fallback.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/av_decode.m");
        cc::Build::new()
            .file("src/av_decode.m")
            .flag("-fobjc-arc")
            .compile("av_decode");
        for fw in [
            "Foundation",
            "AVFoundation",
            "CoreMedia",
            "CoreGraphics",
            "CoreVideo",
        ] {
            println!("cargo:rustc-link-lib=framework={fw}");
        }
    }
}
