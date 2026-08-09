export const MAX_CAMERA_INPUT_BUFFER_BYTES = 1024 * 1024;

const OPEN_WEBSOCKET_STATE = 1;

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function sendBoundedCameraFrame(
  socket,
  metadata,
  jpegBlob,
  maximumBufferedBytes = MAX_CAMERA_INPUT_BUFFER_BYTES,
) {
  if (!socket || socket.readyState !== OPEN_WEBSOCKET_STATE || !jpegBlob) {
    return { sent: false, reason: "socket_unavailable" };
  }
  const serializedMetadata = JSON.stringify(metadata);
  const bufferedAmount = Number(socket.bufferedAmount);
  const frameBytes = Number(jpegBlob.size);
  if (
    !Number.isFinite(bufferedAmount)
    || bufferedAmount < 0
    || !Number.isFinite(frameBytes)
    || frameBytes < 0
    || !Number.isSafeInteger(maximumBufferedBytes)
    || maximumBufferedBytes < 1
  ) {
    return { sent: false, reason: "invalid_buffer_state" };
  }
  const projectedBufferedBytes = bufferedAmount
    + byteLength(serializedMetadata)
    + frameBytes;
  if (projectedBufferedBytes > maximumBufferedBytes) {
    return { sent: false, reason: "backpressure", projectedBufferedBytes };
  }
  socket.send(serializedMetadata);
  socket.send(jpegBlob);
  return { sent: true, reason: null, projectedBufferedBytes };
}
