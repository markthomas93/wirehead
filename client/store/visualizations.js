import db from '../db'

/**
 * ACTION TYPES
 */

const GOT_DATA = 'GOT_DATA'

/**
 * INITIAL STATE
 */
const initialState = []

/**
 * ACTION CREATORS
 */

const gotData = data => ({type: GOT_DATA, data})

/**
 * THUNK CREATORS
 */

export const fetchData = (periodStart, periodEnd, preprocessingParameter) => {
  return async dispatch => {
    const data = await db.history
      .where('timeStart')
      .between(periodStart, periodEnd)
      .toArray()

    if (preprocessingParameter === 'sumBySite') {
      const sites = {}
      data.forEach(site => {
        if (!sites[site.url]) {
          sites[site.url] = {}
          sites[site.url][site.label] = site.timeTotal
        } else {
          sites[site.url][site.label]
            ? (sites[site.url][site.label] += site.timeTotal)
            : (sites[site.url][site.label] = site.timeTotal)
        }
      })
      const siteKeys = Object.keys(sites)
      const sitesArray = siteKeys.map(site => ({
        url: site,
        work: sites[site].work || 0,
        play: sites[site].play || 0
      }))
      dispatch(gotData(sitesArray))
    } else if (preprocessingParameter === 'sumByDayBySite') {
      const result = []
      const days = []
      for (let i = 0; periodStart + i * 60000 * 60 * 24 < periodEnd; i++) {
        days.push(periodStart + i * 60000 * 60 * 24)
      }
      for (const day of days) {
        const sites = {}
        const dayData = data.filter(
          site =>
            site.timeStart >= day && site.timeStart < day + i * 60000 * 60 * 24
        )
        dayData.forEach(site => {
          if (!sites[site.url]) {
            sites[site.url] = {}
            sites[site.url][site.label] = site.timeTotal
          } else {
            sites[site.url][site.label]
              ? (sites[site.url][site.label] += site.timeTotal)
              : (sites[site.url][site.label] = site.timeTotal)
          }
        })
        const siteKeys = Object.keys(sites)
        const sitesArray = siteKeys.map(site => ({
          url: site,
          work: sites[site].work || 0,
          play: sites[site].play || 0
        }))
        result.push(sitesArray)
      }
      dispatch(gotData(result))
    } else if (preprocessingParameter === 'detail') {
      dispatch(gotData(data))
    }
  }
}

/**
 * REDUCER
 */
export default function(state = initialState, action) {
  switch (action.type) {
    case GOT_DATA:
      return action.data
    default:
      return state
  }
}
