import CoreImage
import CoreMedia
import ImageIO

/** Burn ReplayKit's EXIF orientation into bounded pixels: RTMP does not carry it. */
final class ReplayVideoFrameNormalizer {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?
    private var dimensions = CGSize.zero

    func normalize(_ sample: CMSampleBuffer, orientation: CGImagePropertyOrientation) throws -> CMSampleBuffer? {
        guard let source = CMSampleBufferGetImageBuffer(sample) else { throw Failure.invalidFrame }
        let image = CIImage(cvPixelBuffer: source).oriented(orientation)
        let extent = image.extent
        let scale = min(1, 1920 / max(extent.width, extent.height), 1080 / min(extent.width, extent.height))
        let size = CGSize(width: max(2, floor(extent.width * scale / 2) * 2), height: max(2, floor(extent.height * scale / 2) * 2))
        if orientation == .up && scale == 1 { return sample }
        if size != dimensions || pool == nil {
            pool = nil
            let attributes: [CFString: Any] = [kCVPixelBufferWidthKey: Int(size.width), kCVPixelBufferHeightKey: Int(size.height),
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey: [:]]
            guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else { throw Failure.invalidFrame }
            dimensions = size
        }
        var output: CVPixelBuffer?
        guard let pool else { throw Failure.invalidFrame }
        let allocation = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, pool,
            [kCVPixelBufferPoolAllocationThresholdKey: 3] as CFDictionary, &output)
        // The encoder can retain previous frames. Drop under backpressure instead
        // of growing the extension or ending an otherwise healthy broadcast.
        if allocation == kCVReturnWouldExceedAllocationThreshold { return nil }
        guard allocation == kCVReturnSuccess, let output else { throw Failure.invalidFrame }
        let translated = image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
        context.render(translated.transformed(by: CGAffineTransform(scaleX: size.width / extent.width, y: size.height / extent.height)),
            to: output, bounds: CGRect(origin: .zero, size: size), colorSpace: CGColorSpaceCreateDeviceRGB())
        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: output, formatDescriptionOut: &format) == noErr, let format else { throw Failure.invalidFrame }
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sample), presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sample), decodeTimeStamp: CMSampleBufferGetDecodeTimeStamp(sample))
        var result: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: output, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &result) == noErr, let result else { throw Failure.invalidFrame }
        return result
    }
    private enum Failure: Error { case invalidFrame }
}
