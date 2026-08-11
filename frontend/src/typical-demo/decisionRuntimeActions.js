export function exposeDecisionRuntimeActions(decision) {
  return {
    respondConsentGranted: decision.respondConsentGranted,
    respondConsentDenied: decision.respondConsentDenied,
    startDemoConversation: decision.startDemoConversation,
    switchScene: decision.switchScene,
    confirmActionCard: decision.confirmActionCard,
    resetSceneState: decision.resetSceneState,
    replayVoice: decision.replayVoice,
    startVoiceReply: decision.startVoiceReply,
  };
}
