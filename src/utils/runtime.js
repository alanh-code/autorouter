export function getRuntimeContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone
  }).format(now);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timezone
  }).format(now);

  return [
    `Current date: ${date}`,
    `Current time: ${time}`,
    `Timezone: ${timezone}`,
    `Current working directory: ${process.cwd()}`
  ].join("\n");
}
