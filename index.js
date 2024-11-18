// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');
const moment = require('moment-timezone');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3600;

app.use(express.json());

// Paths to files
const attendanceCsvPath = 'attendance.csv';
const coursesJsonPath = 'courses.json';

// Load courses data
let courses = [];
try {
  const coursesData = fs.readFileSync(coursesJsonPath, 'utf8');
  const coursesJson = JSON.parse(coursesData);
  courses = coursesJson.courses;
} catch (error) {
  console.error('Error reading courses.json:', error);
}

// In-memory store for ongoing meetings
const ongoingMeetings = {};

// CSV writer setup
const csvWriter = createObjectCsvWriter({
  path: attendanceCsvPath,
  header: [
    { id: 'teacher_name', title: 'Teacher Name' },
    { id: 'course_name', title: 'Course Name' },
    { id: 'meeting_id', title: 'Meeting ID' },
    { id: 'scheduled_week_day', title: 'Scheduled Week Day' },
    { id: 'attended_week_day', title: 'Attended Week Day' },
    { id: 'date', title: 'Date' },
    { id: 'scheduled_time', title: 'Scheduled Time' },
    { id: 'entered_time', title: 'Entered Time' },
    { id: 'finished_time', title: 'Finished Time' },
    { id: 'total_time', title: 'Total Time (minutes)' },
    { id: 'rate_pound', title: 'Rate (£)' },
    { id: 'rate_formula', title: 'Rate Formula' },
    { id: 'calculated_payment', title: 'Calculated Payment (£)' },
    { id: 'approved_payment', title: 'Approved Payment (£)' },
    { id: 'status', title: 'Status' },
  ],
  append: true,
});

// Ensure CSV file has headers
if (!fs.existsSync(attendanceCsvPath)) {
  csvWriter.writeRecords([]).then(() => {
    console.log('CSV headers written.');
  });
}

// Helper functions
function parseISOTime(timeStr) {
  return moment.tz(timeStr, 'YYYY-MM-DDTHH:mm:ssZ', 'UTC').tz('Europe/London');
}

function parseTime(timeStr) {
  return moment.tz(timeStr, 'HH:mm', 'Europe/London');
}

function getWeekdayName(dateObj) {
  return dateObj.format('dddd');
}

function computeTotalMinutes(startTime, endTime) {
  return endTime.diff(startTime, 'minutes');
}

function getScheduledDateTime(actualStartTime, scheduledWeekDay, scheduledTime) {
  const weekDayNumbers = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  const scheduledWeekDayNum = weekDayNumbers[scheduledWeekDay];

  const actualStartMoment = parseISOTime(actualStartTime);
  const weekStart = actualStartMoment.clone().startOf('week');

  let scheduledDateTime = weekStart
    .clone()
    .add(scheduledWeekDayNum, 'days')
    .set({
      hour: parseInt(scheduledTime.split(':')[0], 10),
      minute: parseInt(scheduledTime.split(':')[1], 10),
      second: 0,
      millisecond: 0,
    });

  // Adjust scheduledDateTime if it's not in the same week as the actual start time
  if (scheduledDateTime.isAfter(actualStartMoment.clone().add(3, 'days'))) {
    scheduledDateTime.subtract(7, 'days');
  } else if (scheduledDateTime.isBefore(actualStartMoment.clone().subtract(3, 'days'))) {
    scheduledDateTime.add(7, 'days');
  }

  return scheduledDateTime;
}

// Endpoint for Zoom webhook events
app.post('/webhook', (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;

  // Handle Zoom endpoint validation
  if (event === 'endpoint.url_validation') {
    const plainToken = payload.plainToken;
    const encryptedToken = crypto
      .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');

    res.status(200).json({
      plainToken,
      encryptedToken,
    });
    return;
  }

  // Verify the request signature
  const timestamp = req.headers['x-zm-request-timestamp'];
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const hashForVerify = crypto
    .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest('hex');
  const signature = `v0=${hashForVerify}`;

  if (req.headers['x-zm-signature'] !== signature) {
    res.status(401).send('Unauthorized request');
    return;
  }

  // Handle meeting.started event
  if (event === 'meeting.started') {
    const meetingId = payload.object.id;
    const topic = payload.object.topic;
    const startTime = payload.object.start_time;

    // Store the start time and topic of the meeting
    ongoingMeetings[meetingId] = {
      topic,
      startTime,
    };

    console.log(`Meeting started: ID ${meetingId}, Topic: ${topic}`);
  }
  // Handle meeting.ended event
  else if (event === 'meeting.ended') {
    const meetingId = payload.object.id;
    const endTime = payload.object.end_time;

    if (ongoingMeetings[meetingId]) {
      const { topic, startTime } = ongoingMeetings[meetingId];

      // Calculate total time in minutes
      const enteredTimeDt = parseISOTime(startTime);
      const finishedTimeDt = parseISOTime(endTime);
      const totalTime = computeTotalMinutes(enteredTimeDt, finishedTimeDt);

      // Match meeting with course
      const course = courses.find((c) => c.course_name === topic);

      if (!course) {
        console.error(`No course found for course_name: ${topic}`);
        delete ongoingMeetings[meetingId];
        return res.status(200).json({ message: 'No matching course found.' });
      }

      const teacherName = course.teacher_name;
      const scheduledWeekDay = course.scheduled_week_day;
      const scheduledTime = course.scheduled_time;
      const ratePound = course.rate_pound;

      const attendedWeekDay = getWeekdayName(enteredTimeDt);
      const date = enteredTimeDt.format('YYYY-MM-DD');
      const enteredTime = enteredTimeDt.format('HH:mm');
      const finishedTime = finishedTimeDt.format('HH:mm');

      const rateFormula = ratePound / 40;
      const calculatedPayment = rateFormula * totalTime;
      const approvedPayment = Math.min(calculatedPayment, ratePound);

      // Determine status
      const scheduledDateTime = getScheduledDateTime(startTime, scheduledWeekDay, scheduledTime);
      const threeMinutesBefore = scheduledDateTime.clone().subtract(3, 'minutes');

      let status = 'Not attended';
      if (enteredTimeDt.isSameOrBefore(threeMinutesBefore)) {
        status = 'Attended';
      }

      // Prepare attendance record
      const attendanceRecord = {
        teacher_name: teacherName,
        course_name: topic,
        meeting_id: meetingId,
        scheduled_week_day: scheduledWeekDay,
        attended_week_day: attendedWeekDay,
        date,
        scheduled_time: scheduledTime,
        entered_time: enteredTime,
        finished_time: finishedTime,
        total_time: totalTime,
        rate_pound: ratePound,
        rate_formula: rateFormula.toFixed(2),
        calculated_payment: calculatedPayment.toFixed(2),
        approved_payment: approvedPayment.toFixed(2),
        status,
      };

      // Save to CSV file
      csvWriter
        .writeRecords([attendanceRecord])
        .then(() => console.log('Attendance record saved to CSV.'))
        .catch((err) => console.error('Error writing to CSV:', err));

      // Remove the meeting from ongoing meetings
      delete ongoingMeetings[meetingId];
    } else {
      console.error(`No ongoing meeting found for ID: ${meetingId}`);
    }
  } else {
    console.log(`Unhandled event type: ${event}`);
  }

  res.status(200).json({ message: 'Event processed.' });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
