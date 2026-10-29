export const generateSessionId = () => {
  return "session-" + crypto.randomUUID();
};
