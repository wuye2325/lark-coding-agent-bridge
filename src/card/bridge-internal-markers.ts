const SHARED_BRIDGE_INTERNAL_TAG = /<\s*\/?\s*(?:bridge_[a-z0-9_-]+|quoted_message|interactive_card|user_message)\b/i;

export function hasSharedBridgeInternalTag(value: string): boolean {
  return SHARED_BRIDGE_INTERNAL_TAG.test(value);
}
