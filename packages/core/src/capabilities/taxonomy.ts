import type { CapabilityDefinition } from '../types/platform.js'
import { stableId } from '../util.js'

/**
 * The capability catalogue is a *taxonomy of product concepts*, not a list of
 * platforms. A platform is described entirely by which of these it declares —
 * which is why the UI, the publisher and the impact engine never branch on a
 * platform name (§8, §19, §20).
 *
 * Entries marked `origin: 'SEED'` are the starting vocabulary. The registry
 * adds new ones at runtime when the Evolution Engine verifies a genuinely new
 * format (§9).
 */
const SEEDED: ReadonlyArray<Omit<CapabilityDefinition, 'createdAt' | 'origin'>> = [
  {
    key: 'TEXT_POST',
    label: 'Text post',
    description: 'A written post with words only.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu'],
    signals: ['text post', 'text-only post', 'status update', 'note'],
  },
  {
    key: 'IMAGE_POST',
    label: 'Image post',
    description: 'A post built from still images.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu'],
    requires: ['IMAGE_MEDIA'],
    signals: ['image post', 'photo post', 'photo carousel of one', 'single image'],
  },
  {
    key: 'IMAGE_MEDIA',
    label: 'Images',
    description: 'The platform accepts still images.',
    domain: 'DISTRIBUTION',
    surfaces: ['media-library'],
    signals: ['jpeg', 'jpg', 'png', 'webp', 'image upload', 'photo upload'],
  },
  {
    key: 'CAROUSEL',
    label: 'Carousel',
    description: 'Several images or videos swiped through in one post.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu'],
    requires: ['IMAGE_MEDIA'],
    signals: ['carousel', 'album', 'multi-image post', 'sidecar'],
  },
  {
    key: 'SHORT_VIDEO',
    label: 'Short video',
    description: 'A short vertical video format.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu', 'video-editor'],
    requires: ['VIDEO_MEDIA'],
    signals: ['reel', 'shorts', 'short video', 'vertical video', 'spot', 'micro video'],
  },
  {
    key: 'LONG_VIDEO',
    label: 'Long video',
    description: 'An uploaded video of substantial length.',
    domain: 'CONTENT',
    surfaces: ['composer', 'video-editor'],
    requires: ['VIDEO_MEDIA'],
    signals: ['long video', 'video upload', 'watch party video', 'premiere'],
  },
  {
    key: 'VIDEO_MEDIA',
    label: 'Video',
    description: 'The platform accepts video files.',
    domain: 'DISTRIBUTION',
    surfaces: ['media-library', 'video-editor'],
    signals: ['mp4', 'mov', 'video upload', 'video file', '.webm'],
  },
  {
    key: 'STORY',
    label: 'Story',
    description: 'A temporary post that disappears after a day.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu'],
    signals: ['story', 'stories', 'status', '24-hour post', 'ephemeral post'],
  },
  {
    key: 'LIVE',
    label: 'Live',
    description: 'A live broadcast from the platform.',
    domain: 'CONTENT',
    surfaces: ['composer', 'create-menu'],
    signals: ['live', 'livestream', 'going live', 'live video', 'broadcast'],
  },
  {
    key: 'POLL',
    label: 'Poll',
    description: 'A post that asks the audience to choose an option.',
    domain: 'ENGAGEMENT',
    surfaces: ['composer', 'create-menu'],
    signals: ['poll', 'quiz', 'question sticker', 'multiple choice post'],
  },
  {
    key: 'THREAD',
    label: 'Thread',
    description: 'A chain of connected posts.',
    domain: 'CONTENT',
    surfaces: ['composer'],
    signals: ['thread', 'threaded post', 'series of posts', '串', 'connected posts'],
  },
  {
    key: 'ARTICLE',
    label: 'Article',
    description: 'A long-form written piece published on the platform.',
    domain: 'CONTENT',
    surfaces: ['composer'],
    signals: ['article', 'long-form post', 'newsletter', 'blog post', 'medium-form'],
  },
  {
    key: 'AUDIO',
    label: 'Audio',
    description: 'An audio clip attached to a post.',
    domain: 'CONTENT',
    surfaces: ['composer', 'audio-editor'],
    requires: ['AUDIO_MEDIA'],
    signals: ['audio', 'voice note', 'sound', 'music track'],
  },
  {
    key: 'AUDIO_MEDIA',
    label: 'Audio files',
    description: 'The platform accepts audio files.',
    domain: 'DISTRIBUTION',
    surfaces: ['media-library'],
    signals: ['mp3', 'aac', 'wav', 'audio upload'],
  },
  {
    key: 'PODCAST_EPISODE',
    label: 'Podcast episode',
    description: 'A full audio episode published as its own item.',
    domain: 'CONTENT',
    surfaces: ['composer'],
    requires: ['AUDIO_MEDIA'],
    signals: ['podcast', 'episode', 'audio series'],
  },
  {
    key: 'SCHEDULING',
    label: 'Scheduling',
    description: 'Creators can choose the date and time a post goes live.',
    domain: 'PUBLISHING',
    surfaces: ['composer', 'calendar'],
    signals: ['schedule', 'scheduled post', 'planned post', 'publish later'],
  },
  {
    key: 'API_PUBLISH',
    label: 'Publishing connection',
    description: 'Creator Mall can post to this platform on the creator’s behalf.',
    domain: 'PUBLISHING',
    surfaces: ['publishing', 'integrations'],
    signals: ['publish api', 'content publishing api', 'create a post endpoint', 'posting api'],
  },
  {
    key: 'API_ANALYTICS',
    label: 'Analytics connection',
    description: 'Creator Mall can read this platform’s performance data.',
    domain: 'ANALYTICS',
    surfaces: ['analytics', 'integrations'],
    signals: ['insights api', 'analytics api', 'account statistics api', 'channel statistics api'],
  },
  {
    key: 'ANALYTICS',
    label: 'Creator analytics',
    description: 'The platform shows the creator how their content performed.',
    domain: 'ANALYTICS',
    surfaces: ['analytics'],
    signals: ['insights', 'analytics', 'statistics', 'dashboard', 'performance data'],
  },
  {
    key: 'WEBHOOKS',
    label: 'Real-time notifications',
    description: 'The platform pushes updates to connected software.',
    domain: 'ANALYTICS',
    surfaces: ['integrations'],
    signals: ['webhook', 'callback url', 'notification endpoint'],
  },
  {
    key: 'COMMENT_REPLIES',
    label: 'Comment replies',
    description: 'Creators can reply to comments on their posts.',
    domain: 'ENGAGEMENT',
    surfaces: ['inbox', 'engagement'],
    signals: ['reply to comment', 'comment reply', 'threaded comments'],
  },
  {
    key: 'DM_MESSAGING',
    label: 'Direct messages',
    description: 'Creators can hold private message conversations with their audience.',
    domain: 'ENGAGEMENT',
    surfaces: ['inbox', 'engagement'],
    signals: ['direct message', 'dm', 'private message', 'messenger'],
  },
  {
    key: 'COLLABORATION',
    label: 'Collaborative posts',
    description: 'Two or more creators can publish together.',
    domain: 'ENGAGEMENT',
    surfaces: ['composer', 'collaborations'],
    signals: ['collab', 'collaboration', 'co-author', 'duet', 'remix', 'collab post'],
  },
  {
    key: 'BRANDED_CONTENT',
    label: 'Paid partnerships',
    description: 'The platform labels content that is paid or sponsored.',
    domain: 'MONETIZATION',
    surfaces: ['composer', 'monetization'],
    signals: ['branded content', 'paid partnership', 'sponsored content label', 'brand collaboration'],
  },
  {
    key: 'CREATOR_FUNDING',
    label: 'Platform creator payouts',
    description: 'The platform pays creators directly for their content.',
    domain: 'MONETIZATION',
    surfaces: ['monetization', 'earnings'],
    signals: ['creator fund', 'monetization program', 'creator payouts', 'revenue share', 'partner program'],
  },
  {
    key: 'IN_APP_PURCHASING',
    label: 'In-app purchases',
    description: 'Creators can sell digital goods or perks to their audience.',
    domain: 'MONETIZATION',
    surfaces: ['monetization'],
    signals: ['in-app purchase', 'digital goods', 'subscriptions', 'paid membership', 'tips'],
  },
  {
    key: 'SHOPPING',
    label: 'Product tagging',
    description: 'Creators can tag products for their audience to buy.',
    domain: 'MONETIZATION',
    surfaces: ['composer', 'monetization'],
    signals: ['product tag', 'shopping', 'shop tab', 'affiliate', 'product link'],
  },
  {
    key: 'SUBTITLES',
    label: 'Automatic captions',
    description: 'The platform can add captions to videos.',
    domain: 'CREATOR_TOOLS',
    surfaces: ['video-editor'],
    signals: ['auto caption', 'automatic subtitle', 'captions', 'transcription'],
  },
  {
    key: 'TREND_SOUND_LIBRARY',
    label: 'Trending audio',
    description: 'A library of audio that is currently popular on the platform.',
    domain: 'CREATOR_TOOLS',
    surfaces: ['composer', 'audio-library'],
    signals: ['trending sound', 'popular audio', 'sound library', 'viral audio'],
  },
  {
    key: 'ARCHIVING',
    label: 'Permanent posts',
    description: 'Posts can be edited or kept live indefinitely.',
    domain: 'DISTRIBUTION',
    surfaces: ['composer'],
    signals: ['archive', 'permanent post', 'pinned post', 'edit post'],
  },
]

export function seededCapabilityDefinitions(): CapabilityDefinition[] {
  const createdAt = new Date(0).toISOString()
  return SEEDED.map((definition) => ({
    ...definition,
    origin: 'SEED' as const,
    createdAt,
  }))
}

export function capabilityDefinitionId(key: string): string {
  return stableId('cap', key)
}
