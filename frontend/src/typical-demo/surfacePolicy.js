const HOME_REMOTE_COMMANDS = new Set(["acknowledge_alarm", "confirm_alarm"]);

export function normalizeSurface(surface) {
  return surface === "debug" ? "debug" : "home";
}

export function initialSceneForSurface(surface) {
  return normalizeSurface(surface) === "home" ? "living" : "fall";
}

export function allowsRemoteCommand(surface, commandName) {
  if (normalizeSurface(surface) === "debug") return true;
  return HOME_REMOTE_COMMANDS.has(commandName);
}

export function exposesDebugInterface(surface) {
  return normalizeSurface(surface) === "debug";
}

export function remoteActionsForSurface(surface, actions) {
  if (normalizeSurface(surface) === "debug") return { ...actions };
  return { confirmAlarm: actions.confirmAlarm };
}
