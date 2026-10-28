const PROVIDER_CHANNEL_ATTRIBUTE = 'channel';

export function getProviderChannelName(
  script: HTMLScriptElement | null = document.currentScript as HTMLScriptElement | null
): string {
  const channelName = script?.getAttribute(PROVIDER_CHANNEL_ATTRIBUTE)?.trim();
  if (!channelName) {
    throw new Error('Qbit provider transport channel is missing');
  }
  return channelName;
}
