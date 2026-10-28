enum ActivityStatus {
  NOT_STARTED = 0,
  UPCOMING = 1,
  ONGOING = 2,
  ENDED = 3,
}

export interface Activity {
  id: string
  name: string
  startTime?: string
  endTime: string
  status?: ActivityStatus
  bannerUrl: string
  bannerLinkUrl: string
  comingOn?: boolean
}
