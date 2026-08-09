function invokeAttempt(action) {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Start local care from the user's media gesture while Relay connects in the
 * background. Remote family sync may degrade, but it must never gate capture.
 */
export async function startLocalDemoSession({
  markStarted,
  startCapture,
  startRelay,
}) {
  if (
    typeof markStarted !== "function"
    || typeof startCapture !== "function"
    || typeof startRelay !== "function"
  ) throw new TypeError("本机演示启动动作不完整");

  markStarted();
  const captureAttempt = invokeAttempt(startCapture);
  const relayAttempt = invokeAttempt(startRelay).catch(() => false);
  void relayAttempt;

  return (await captureAttempt.catch(() => false)) !== false;
}
