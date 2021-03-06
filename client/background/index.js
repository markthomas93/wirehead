/*global chrome*/
/*
The structure of the background scripts is as follows:
*index.js (this file), we have all our event listeners - I think they have to be here
*utils.js is utility functions for use by index.js
*db builds the db schema
*bayesClassifier.js is for use by Kevin
*don't hesitate to add new files as needed!
*/
import {
  getBayesModel,
  updateBayesModel,
  getClassifications,
  classifyDocument,
  getNumberOfTrainingExamples,
  deleteOldTrainingData,
  classifyDocumentIfBayesModel
} from './bayesClassifier'
import {initOptions, updateOptions, getOptions} from './options'
import {timeCalculator, urlValidation, titleCutter} from './utils'
import {makeLearnMoreNotification} from './newUserTest'
import db from '../db'

//session variables so we know whether to prompt the user to learn more
//or maybe per-window. Either way not too annoying
let aboutNotificationClicked = false
const clickAboutNotification = () => {
  aboutNotificationClicked = true
}
function handleNotificationClick(notificationId) {
  if (notificationId === 'dashboard.html#about') {
    clickAboutNotification()
    chrome.tabs.create({url: notificationId})
  }
}

chrome.notifications.onClicked.addListener(handleNotificationClick)

// Is chrome in focus? We will check this var before sending notifications
let chromeIsInFocus = true
chrome.windows.onFocusChanged.addListener(function(window) {
  if (window === chrome.windows.WINDOW_ID_NONE) {
    chromeIsInFocus = false
  } else {
    chromeIsInFocus = true
  }
})

//We remake the bayes model less often when we have  LOTS  of examples
const LOTS_OF_TRAINING_EXAMPLES = 2000
//We cull old traingin examples from db after reaching MAX
const MAX_TRAINING_EXAMPLES = 10000

//Store the data when a chrome window switched
chrome.windows.onFocusChanged.addListener(function(windowInfo) {
  //Prevent error when all of the windows are focused out which is -1
  //It runs only currentWindow ID has been changed

  if (chromeIsInFocus) {
    chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs => {
      updateIcon(tabs[0])
      if (tabs[0] && urlValidation(new URL(tabs[0].url))) {
        var url = new URL(tabs[0].url)
        var currentUrl

        //Post start time data when open the tab
        db.history
          .where('timeStart')
          .between(new Date().setHours(0, 0, 0, 0), new Date().valueOf())
          .toArray()
          .then(result => {
            if (result[0]) {
              var idx = result.length - 1
              currentUrl = result[idx].url
            }
          })
          .then(async () => {
            if (currentUrl !== url.hostname) {
              db.history
                ///Put bayes label here
                .put({
                  url: url.hostname,
                  timeStart: new Date().valueOf(),
                  timeEnd: new Date().valueOf(),
                  timeTotal: 0,
                  label: await classifyDocumentIfBayesModel(tabs[0].title)
                })
            }
          })
      }
    })
  }
})

chrome.tabs.onActivated.addListener(function(activeInfo) {
  killNotification()
  //get detail information of activated tab
  chrome.tabs.get(activeInfo.tabId, async function(tab) {
    updateIcon(tab)
    const model = await getBayesModel()

    if (!model) {
      makeLearnMoreNotification(aboutNotificationClicked)
    }
    //this code creates a transaction and uses it to write to the db
    var url = tab.url && new URL(tab.url)

    //Post start time data when open the tab
    if (urlValidation(tab.url && new URL(tab.url))) {
      db.history.put({
        url: url.hostname,
        timeStart: new Date().valueOf(),
        timeEnd: new Date().valueOf(),
        timeTotal: 0,
        label: await classifyDocumentIfBayesModel(tab.title)
      })
    }
  })
})

//An Event Listener to store data when URL has been changed
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  killNotification()
  updateIcon(tab)
  if (tab.active && tab.status === 'complete') {
    var url = tab.url && new URL(tab.url)
    var currentUrl

    //Update time end when focus out of the tab
    db.history
      .where('timeStart')
      .between(new Date().setHours(0, 0, 0, 0), new Date().valueOf())
      .toArray()
      .then(result => {
        if (result[0]) {
          var idx = result.length - 1
          currentUrl = result[idx].url
        }
      })
      .then(async () => {
        if (
          currentUrl !== url.hostname &&
          urlValidation(tab.url && new URL(tab.url))
        ) {
          db.history.put({
            url: url.hostname,
            timeStart: new Date().valueOf(),
            timeEnd: new Date().valueOf(),
            timeTotal: 0,
            label: await classifyDocumentIfBayesModel(tab.title)
          })
        }
      })
  }
})

//This function updates the icon and badge according to ML prediction
async function updateIcon(tab) {
  const model = await getBayesModel()
  if (!model || !tab.url.startsWith('http') || tab.url.includes('newtab')) {
    chrome.browserAction.setBadgeText({text: ''})
  } else {
    //page classification is either "work" or "play"
    const pageClassification = await classifyDocumentIfBayesModel(tab.title)
    //We format the raw output of machine learning model (const probabilities, decimals)
    const probabilities = await getClassifications(tab.title)
    //as a percentage (certainty)
    let certainty
    if (probabilities.length > 0) {
      certainty =
        (probabilities[0].value /
          (probabilities[0].value + probabilities[1].value)) *
        100
    }

    if (pageClassification === 'work') {
      chrome.browserAction.setBadgeBackgroundColor({color: 'green'})
    } else if (pageClassification === 'play') {
      chrome.browserAction.setBadgeBackgroundColor({color: 'red'})
    } else {
      chrome.browserAction.setBadgeBackgroundColor({color: 'gray'})
    }
    if (certainty) {
      chrome.browserAction.setBadgeText({
        text: String(certainty).slice(0, 2) + '%'
      })
    } else {
      chrome.browserAction.setBadgeText({
        text: '??%'
      })
    }
  }
}

//This alarm should update the bayes model with new training data about one every day
//but only if we have LOTS_OF_TRAINING_DATA (2000 lines in db)
//which would make updating the model computationaly expensive
//Otherwise, we can just update the model every time we add a single training datum
chrome.alarms.create('update bayes model', {periodInMinutes: 1000})

chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name === 'update bayes model') {
    const numberExamples = await getNumberOfTrainingExamples()
    if (numberExamples >= LOTS_OF_TRAINING_EXAMPLES) {
      updateBayesModel()
    }
  }
})

//NOTFICATION STUFF IS BELOW

//This initializes alarm that causes notifications to be made
chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === 'install') {
    chrome.alarms.create('make notification', {periodInMinutes: 15})
  }
})

//User will be notified by hour how long they stayed on the website
chrome.alarms.create('timer', {periodInMinutes: 60})

chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name === 'timer' && chromeIsInFocus) {
    timeNotification()
  } else if (alarm.name === 'make notification') {
    const options = await getOptions()
    if (options.trainingPopupFrequency !== 'never') {
      chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs => {
        if (
          tabs[0] &&
          urlValidation(new URL(tabs[0].url)) &&
          tabs[0].url.startsWith('http') &&
          !tabs[0].url.includes('newtab')
        ) {
          makeNotification(tabs[0].favIconUrl)
        }
      })
    }
  }
})

//Timer keep tracks current time per second & if laptop is turned off
setInterval(() => {
  if (chromeIsInFocus) {
    timeTracker()
  }
}, 1000)

chrome.notifications.onClicked.addListener(redirectToDashboard)

function makeNotification(icon) {
  var iconUrl = 'gray.png'
  if (icon) {
    iconUrl = icon
  }

  if (chromeIsInFocus) {
    chrome.notifications.onClicked.removeListener(redirectToDashboard)
    chrome.notifications.onButtonClicked.removeListener(handleButton)
    chrome.notifications.create('training notification', {
      type: 'basic',
      title: 'Train the Wirehead AI',
      iconUrl,
      message: 'Classify this page as work or play -->',
      buttons: [{title: 'This is work'}, {title: 'This is play'}]
    })
    chrome.notifications.onButtonClicked.addListener(handleButton)
  }
}

function redirectToDashboard(notificationId) {
  if (notificationId !== 'dashboard.html#about')
    chrome.tabs.create({url: 'dashboard.html'})
}

function killNotification() {
  chrome.notifications.onButtonClicked.removeListener(handleButton)
  chrome.notifications.clear('training notification')
}

//Clicking buttons on notification does a lot of things:
//1. It adds training examples to the db, labeled "work" or "play"
//2. If we don't have a lot of training examples...
//it updates the machine learning model, makes a new prediction, and updates the icon
//3. If we have too many training examples it tells the db to drop 100 lines
function handleButton(notificationId, buttonIndex) {
  chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
    const currentTab = tabs[0]
    let label
    if (buttonIndex === 0) {
      label = 'work'
    } else if (buttonIndex === 1) {
      label = 'play'
    }

    processNewTrainingExample(currentTab, label)
  })
}

//Mostly just adds a new training example to dbx
async function processNewTrainingExample(currentTab, label) {
  db.trainingData.add({
    document: currentTab.title,
    label: label,
    time: new Date().getTime()
  })

  checkForAlarmUpdates()

  //Slowly decrease frequency of popup (in minutes) as user uses the extension more
  //stop constantly updating the bayes model if we have a lots of training examples,
  //so as not to make chrome really slow
  const numberExamples = await getNumberOfTrainingExamples()
  if (numberExamples < LOTS_OF_TRAINING_EXAMPLES) {
    await updateBayesModel()
    await updateIcon(currentTab)
  }
  //Delete older training data if we have accumulated a ton
  else if (numberExamples > MAX_TRAINING_EXAMPLES) {
    deleteOldTrainingData()
  }
}

//Once we have a lot of Bayes examples, we can annoy the user for training data less often
async function checkForAlarmUpdates() {
  const numberExamples = await getNumberOfTrainingExamples()
  const options = await getOptions()
  const trainingPopupFrequency = options.trainingPopupFrequency
  if (numberExamples > 1000 || trainingPopupFrequency === 'low') {
    updateNotificationFrequency(60)
  } else if (numberExamples > 500) {
    updateNotificationFrequency(45)
  } else if (numberExamples > 200) {
    updateNotificationFrequency(30)
  } else if (numberExamples > 100) {
    updateNotificationFrequency(20)
  }
}

//This updates the frequency of the alarm that makes notifications (used below)
function updateNotificationFrequency(newPeriod) {
  chrome.alarms.clear('make notification')
  chrome.alarms.create('make notification', {periodInMinutes: newPeriod})
}

function timeNotification() {
  //If there's an active page, get the page title and init a notification

  chrome.tabs.query({active: true, lastFocusedWindow: true}, async tabs => {
    const options = await getOptions()
    const allowShaming = options.allowShaming
    if (allowShaming && tabs[0] && urlValidation(new URL(tabs[0].url))) {
      db.history
        .where('timeStart')
        .between(new Date().setHours(0, 0, 0, 0), new Date().valueOf())
        .toArray()
        .then(async result => {
          if (result) {
            let idx = result.length - 1
            if (result[idx].label === 'play') {
              var totalSpend = 0
              result.forEach(data => {
                if (data.label === 'play') {
                  totalSpend += data.timeTotal
                }
              })

              var hourCalculator = Math.floor(totalSpend / 3600000) * 3600000
              if (
                totalSpend > hourCalculator &&
                totalSpend < hourCalculator + 12000 &&
                totalSpend > 10000
              ) {
                makeTimeNotification(totalSpend)
              }
            }
          }
        })
    }
  })
}

function makeTimeNotification(time) {
  var timeprint = timeCalculator(time)

  chrome.notifications.create({
    type: 'basic',
    title: 'Unproductive time today',
    iconUrl: 'heartwatch.png',
    message: 'Total: ' + timeprint
  })
}

function timeTracker() {
  chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs => {
    if (tabs[0] && urlValidation(new URL(tabs[0].url))) {
      db.history
        .where('timeStart')
        .between(new Date().setHours(0, 0, 0, 0), new Date().valueOf())
        .toArray()
        .then(result => {
          var idx = result.length - 1
          return result[idx]
        })
        .then(async data => {
          if (
            data &&
            new Date().valueOf() - (data.timeEnd || new Date().valueOf()) <
              10000
          ) {
            db.history.update(data.id, {
              timeEnd: new Date().valueOf(),
              timeTotal: new Date().valueOf() - data.timeStart
            })
          } else {
            db.history.put({
              url: new URL(tabs[0].url).hostname,
              timeStart: new Date().valueOf(),
              timeEnd: new Date().valueOf(),
              timeTotal: 0,
              label: await classifyDocumentIfBayesModel(tabs[0].title)
            })
          }
        })
    }
  })
}

//Handles incoing messages
chrome.runtime.onMessage.addListener(function(message) {
  //Handles classification in the popup
  if (message.action === 'classify website' && message.label) {
    chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs => {
      if (tabs[0]) {
        processNewTrainingExample(tabs[0], message.label)
      }
    })
    //Handles changing options in the dashboard
  } else if (message.action === 'options updated') {
    checkForAlarmUpdates()
  }
})
