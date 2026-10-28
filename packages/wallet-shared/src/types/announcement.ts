export enum AnnouncementLinkType {
  EXTERNAL_LINK = 'EXTERNAL_LINK',
  INTERNAL_LINK = 'INTERNAL_LINK',
  INTERNAL_ROUTE = 'INTERNAL_ROUTE',
  NONE = 'NONE',
}
export interface Announcement {
  id: string
  title: string
  description: string
  startTime: number
  endTime: number
  link: string
  linkType: AnnouncementLinkType
}
