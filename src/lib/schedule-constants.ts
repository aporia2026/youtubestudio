// Shared between server + client so the "virtual" tab id for items with no
// channel links never diverges. The schedule GET handler and the ChannelTabs
// component both import from here.
export const UNASSIGNED_CHANNEL_ID = '__unassigned';
