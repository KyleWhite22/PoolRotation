export function rotationPk(date: string, instanceId?: string) {
  return instanceId ? `ROTATION#${date}#INSTANCE#${instanceId}` : `ROTATION#${date}`;
}

export function rotationKey(date: string, instanceId?: string) {
  return { pk: rotationPk(date, instanceId), sk: "STATE" };
}
