// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const moment = require('moment-timezone');
const crypto = require('crypto');
const nodeCron = require('node-cron');
const nodemailer = require('nodemailer');
const path = require('path');
const http = require('http'); // Required for Socket.io
const socketIo = require('socket.io'); // Socket.io for real-time updates
const csvWriter = require('csv-writer').createObjectCsvWriter;
const csvParser = require('csv-parser'); // For reading CSV files

const app = express();
const port = process.env.PORT || 3600;

// Create HTTP server and initialize Socket.io
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

// Paths
const coursesJsonPath = 'courses.json';
const attendanceCsvPath = 'attendance.csv';
const reportsDir = path.join(__dirname, 'Reports');

// Ensure the Reports directory exists
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir);
}

// Load courses data
let courses = [];
function loadCourses() {
  try {
    const coursesData = fs.readFileSync(coursesJsonPath, 'utf8');
    const coursesJson = JSON.parse(coursesData);
    courses = coursesJson.courses;
  } catch (error) {
    console.error('Error reading courses.json:', error);
  }
}

// In-memory store for ongoing meetings
const ongoingMeetings = {};

// In-memory store for today's attendance records
let todaysAttendanceRecords = [];

// Helper functions
function parseISOTime(timeStr) {
  return moment.tz(timeStr, 'YYYY-MM-DDTHH:mm:ssZ', 'UTC').tz('Europe/London');
}

function getWeekdayName(dateObj) {
  return dateObj.format('dddd');
}

function computeTotalMinutes(startTime, endTime) {
  return endTime.diff(startTime, 'minutes');
}

function getScheduledDateTime(date, scheduledTime) {
  return moment.tz(`${date} ${scheduledTime}`, 'YYYY-MM-DD HH:mm', 'Europe/London');
}

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

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
    const meetingId = payload.object.id.toString(); // Ensure it's a string
    const topic = payload.object.topic;
    const startTime = payload.object.start_time;
    const hostId = payload.object.host_id || null; // Handle undefined host_id

    // Added console log for meeting.started payload
    console.log('meeting.started payload:', payload);

    // Store the start time, topic, and host id of the meeting
    ongoingMeetings[meetingId] = {
      topic,
      startTime,
      hostId, // May be null
    };

    console.log(`Meeting started: ID ${meetingId}, Topic: ${topic}`);

    // Save details to attendance.csv
    const enteredTimeDt = parseISOTime(startTime);
    const todayDate = enteredTimeDt.format('YYYY-MM-DD');
    const enteredTime = enteredTimeDt.format('HH:mm');

    // Find matching course
    const matchingCourse = courses.find(
      (course) =>
        course.course_name === topic &&
        course.week_day === getWeekdayName(enteredTimeDt)
    );

    if (!matchingCourse) {
      console.error(`No matching course found for topic: ${topic}`);
      return res.status(200).json({ message: 'No matching course found.' });
    }

    const attendanceRecord = {
      course_id: matchingCourse.course_id,
      course_name: matchingCourse.course_name,
      teacher_name: matchingCourse.teacher_name,
      week_day: matchingCourse.week_day,
      scheduled_time: matchingCourse.scheduled_time,
      host_id: hostId || 'N/A',
      today_date: todayDate,
      entered_time: enteredTime,
      finished_time: '',
      total_time: '',
      status: '',
    };

    // Append to attendance.csv
    appendToAttendanceCSV(attendanceRecord);

    // Emit event to clients
    io.emit('attendanceUpdated', attendanceRecord);
  }
  // Handle meeting.ended event
  else if (event === 'meeting.ended') {
    const meetingId = payload.object.id.toString(); // Ensure it's a string
    const endTime = payload.object.end_time;

    // Added console log for meeting.ended payload
    console.log('meeting.ended payload:', payload);

    if (ongoingMeetings[meetingId]) {
      const { topic, startTime, hostId } = ongoingMeetings[meetingId];

      // Meeting times and calculations
      const enteredTimeDt = parseISOTime(startTime);
      const finishedTimeDt = parseISOTime(endTime);
      const totalTime = computeTotalMinutes(enteredTimeDt, finishedTimeDt);

      const todayDate = enteredTimeDt.format('YYYY-MM-DD');
      const enteredTime = enteredTimeDt.format('HH:mm');
      const finishedTime = finishedTimeDt.format('HH:mm');

      // Find matching course
      const matchingCourse = courses.find(
        (course) =>
          course.course_name === topic &&
          course.week_day === getWeekdayName(enteredTimeDt)
      );

      if (!matchingCourse) {
        console.error(`No matching course found for topic: ${topic}`);
        delete ongoingMeetings[meetingId];
        return res.status(200).json({ message: 'No matching course found.' });
      }

      // Update attendance.csv
      updateAttendanceCSV({
        course_id: matchingCourse.course_id,
        course_name: matchingCourse.course_name,
        teacher_name: matchingCourse.teacher_name,
        week_day: matchingCourse.week_day,
        scheduled_time: matchingCourse.scheduled_time,
        host_id: hostId || 'N/A',
        today_date: todayDate,
        entered_time: enteredTime,
        finished_time: finishedTime,
        total_time: totalTime,
        status: '',
      });

      // Remove from ongoing meetings
      delete ongoingMeetings[meetingId];

      // Emit event to clients
      io.emit('attendanceUpdated', {});
    } else {
      console.error(`No ongoing meeting found for ID: ${meetingId}`);
    }
  } else {
    console.log(`Unhandled event type: ${event}`);
  }

  res.status(200).json({ message: 'Event processed.' });
});

// Function to append a record to attendance.csv
function appendToAttendanceCSV(record) {
  const headers = [
    { id: 'course_id', title: 'Course ID' },
    { id: 'course_name', title: 'Course Name' },
    { id: 'teacher_name', title: 'Teacher Name' },
    { id: 'week_day', title: 'Week Day' },
    { id: 'scheduled_time', title: 'Scheduled Time' },
    { id: 'host_id', title: 'Host ID' },
    { id: 'today_date', title: 'Date' },
    { id: 'entered_time', title: 'Entered Time' },
    { id: 'finished_time', title: 'Finished Time' },
    { id: 'total_time', title: 'Total Time (minutes)' },
    { id: 'status', title: 'Status' },
  ];

  const writer = csvWriter({
    path: attendanceCsvPath,
    header: headers,
    append: fs.existsSync(attendanceCsvPath),
  });

  writer
    .writeRecords([record])
    .then(() => console.log('Attendance record added'))
    .catch((err) => console.error('Error writing to attendance.csv:', err));
}

// Function to update a record in attendance.csv
function updateAttendanceCSV(updatedRecord) {
  const records = [];
  fs.createReadStream(attendanceCsvPath)
    .pipe(csvParser())
    .on('data', (data) => {
      if (
        data.course_id === updatedRecord.course_id &&
        data.today_date === updatedRecord.today_date
      ) {
        // Update the record
        data.finished_time = updatedRecord.finished_time;
        data.total_time = updatedRecord.total_time;
      }
      records.push(data);
    })
    .on('end', () => {
      const headers = [
        { id: 'course_id', title: 'Course ID' },
        { id: 'course_name', title: 'Course Name' },
        { id: 'teacher_name', title: 'Teacher Name' },
        { id: 'week_day', title: 'Week Day' },
        { id: 'scheduled_time', title: 'Scheduled Time' },
        { id: 'host_id', title: 'Host ID' },
        { id: 'today_date', title: 'Date' },
        { id: 'entered_time', title: 'Entered Time' },
        { id: 'finished_time', title: 'Finished Time' },
        { id: 'total_time', title: 'Total Time (minutes)' },
        { id: 'status', title: 'Status' },
      ];

      const writer = csvWriter({
        path: attendanceCsvPath,
        header: headers,
      });

      writer
        .writeRecords(records)
        .then(() => console.log('Attendance record updated'))
        .catch((err) => console.error('Error writing to attendance.csv:', err));
    });
}

// Function to check attendance at scheduled course times
function checkAttendance() {
  const today = moment().tz('Europe/London').format('YYYY-MM-DD');
  const weekDay = moment().tz('Europe/London').format('dddd');

  courses.forEach((course) => {
    if (course.week_day === weekDay) {
      const scheduledDateTime = getScheduledDateTime(today, course.scheduled_time);

      // Only schedule if the time is in the future
      if (scheduledDateTime.isAfter(moment().tz('Europe/London'))) {
        const checkTime = scheduledDateTime.clone(); // At scheduled time

        const cronExpression = `${checkTime.minute()} ${checkTime.hour()} ${checkTime.date()} ${checkTime.month() + 1} *`;

        nodeCron.schedule(cronExpression, () => {
          console.log(`Checking attendance for course: ${course.course_name}`);

          // Read attendance.csv
          const records = [];
          if (fs.existsSync(attendanceCsvPath)) {
            fs.createReadStream(attendanceCsvPath)
              .pipe(csvParser())
              .on('data', (data) => {
                records.push(data);
              })
              .on('end', () => {
                const matchingRecord = records.find(
                  (record) =>
                    record.course_id === course.course_id.toString() &&
                    record.today_date === today
                );

                if (!matchingRecord || matchingRecord.finished_time) {
                  // Not attended
                  const status = 'Not Attended';
                  sendEmailToIT({
                    subject: `Course Not Attended - ${course.course_name}`,
                    text: `The course "${course.course_name}" scheduled at ${course.scheduled_time} was not attended.`,
                  });

                  // Update attendance.csv
                  const newRecord = {
                    course_id: course.course_id,
                    course_name: course.course_name,
                    teacher_name: course.teacher_name,
                    week_day: course.week_day,
                    scheduled_time: course.scheduled_time,
                    host_id: 'N/A',
                    today_date: today,
                    entered_time: '',
                    finished_time: '',
                    total_time: '',
                    status: status,
                  };

                  appendToAttendanceCSV(newRecord);

                  // Emit event to clients
                  io.emit('attendanceUpdated', newRecord);
                } else if (matchingRecord && !matchingRecord.finished_time) {
                  // Attended
                  const status = 'Attended';

                  // Update status in attendance.csv
                  matchingRecord.status = status;

                  // Re-write attendance.csv
                  const headers = [
                    { id: 'course_id', title: 'Course ID' },
                    { id: 'course_name', title: 'Course Name' },
                    { id: 'teacher_name', title: 'Teacher Name' },
                    { id: 'week_day', title: 'Week Day' },
                    { id: 'scheduled_time', title: 'Scheduled Time' },
                    { id: 'host_id', title: 'Host ID' },
                    { id: 'today_date', title: 'Date' },
                    { id: 'entered_time', title: 'Entered Time' },
                    { id: 'finished_time', title: 'Finished Time' },
                    { id: 'total_time', title: 'Total Time (minutes)' },
                    { id: 'status', title: 'Status' },
                  ];

                  const updatedRecords = records.map((record) =>
                    record.course_id === matchingRecord.course_id &&
                    record.today_date === matchingRecord.today_date
                      ? matchingRecord
                      : record
                  );

                  const writer = csvWriter({
                    path: attendanceCsvPath,
                    header: headers,
                  });

                  writer
                    .writeRecords(updatedRecords)
                    .then(() => console.log('Attendance status updated'))
                    .catch((err) =>
                      console.error('Error writing to attendance.csv:', err)
                    );

                  // Emit event to clients
                  io.emit('attendanceUpdated', matchingRecord);
                }
              });
          } else {
            // attendance.csv doesn't exist, so course was not attended
            const status = 'Not Attended';
            sendEmailToIT({
              subject: `Course Not Attended - ${course.course_name}`,
              text: `The course "${course.course_name}" scheduled at ${course.scheduled_time} was not attended.`,
            });

            // Update attendance.csv
            const newRecord = {
              course_id: course.course_id,
              course_name: course.course_name,
              teacher_name: course.teacher_name,
              week_day: course.week_day,
              scheduled_time: course.scheduled_time,
              host_id: 'N/A',
              today_date: today,
              entered_time: '',
              finished_time: '',
              total_time: '',
              status: status,
            };

            appendToAttendanceCSV(newRecord);

            // Emit event to clients
            io.emit('attendanceUpdated', newRecord);
          }
        });
      }
    }
  });
}

// Function to send email to IT
function sendEmailToIT({ subject, text }) {
  const mailOptions = {
    from: process.env.SMTP_USER,
    to: process.env.IT_EMAIL,
    subject,
    text,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return console.error('Error sending email:', error);
    }
    console.log('Email sent:', info.response);
  });
}

// Function to generate teacher reports at the end of the month
function generateTeacherReports() {
  const today = moment().tz('Europe/London');
  const tomorrow = today.clone().add(1, 'day');

  // Check if today is the last day of the month
  if (today.month() !== tomorrow.month()) {
    console.log('Generating teacher reports...');

    const currentMonthYear = today.format('MMMM YYYY');
    const monthDir = path.join(reportsDir, `${currentMonthYear}`);

    // Ensure the month directory exists
    if (!fs.existsSync(monthDir)) {
      fs.mkdirSync(monthDir);
    }

    // Read attendance.csv
    const records = [];
    if (fs.existsSync(attendanceCsvPath)) {
      fs.createReadStream(attendanceCsvPath)
        .pipe(csvParser())
        .on('data', (data) => {
          records.push(data);
        })
        .on('end', () => {
          // Group records by teacher_name
          const recordsByTeacher = records.reduce((acc, record) => {
            const teacherName = record.teacher_name;
            if (!acc[teacherName]) {
              acc[teacherName] = [];
            }
            acc[teacherName].push(record);
            return acc;
          }, {});

          // Write each teacher's records to their own CSV file
          Object.keys(recordsByTeacher).forEach((teacherName) => {
            const sanitizedTeacherName = teacherName.replace(/[/\\?%*:|"<>]/g, '-');
            const teacherCsvPath = path.join(
              monthDir,
              `${sanitizedTeacherName} - ${currentMonthYear}.csv`
            );

            const headers = [
              { id: 'course_id', title: 'Course ID' },
              { id: 'course_name', title: 'Course Name' },
              { id: 'teacher_name', title: 'Teacher Name' },
              { id: 'week_day', title: 'Week Day' },
              { id: 'scheduled_time', title: 'Scheduled Time' },
              { id: 'host_id', title: 'Host ID' },
              { id: 'today_date', title: 'Date' },
              { id: 'entered_time', title: 'Entered Time' },
              { id: 'finished_time', title: 'Finished Time' },
              { id: 'total_time', title: 'Total Time (minutes)' },
              { id: 'status', title: 'Status' },
            ];

            const writer = csvWriter({
              path: teacherCsvPath,
              header: headers,
            });

            writer
              .writeRecords(recordsByTeacher[teacherName])
              .then(() => console.log(`Report generated for ${teacherName}`))
              .catch((err) =>
                console.error(`Error writing report for ${teacherName}:`, err)
              );
          });
        });
    } else {
      console.log('No attendance records found for this month.');
    }
  } else {
    console.log('Today is not the last day of the month. No reports generated.');
  }
}

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('A client connected');

  // Send today's attendance records to the client
  sendAttendanceDataToClient(socket);

  socket.on('disconnect', () => {
    console.log('A client disconnected');
  });
});

// Function to send attendance data to client
function sendAttendanceDataToClient(socket) {
  const today = moment().tz('Europe/London').format('YYYY-MM-DD');
  const records = [];
  if (fs.existsSync(attendanceCsvPath)) {
    fs.createReadStream(attendanceCsvPath)
      .pipe(csvParser())
      .on('data', (data) => {
        if (data.today_date === today) {
          records.push(data);
        }
      })
      .on('end', () => {
        socket.emit('initialData', records);
      });
  } else {
    socket.emit('initialData', []);
  }
}

// Schedule tasks
nodeCron.schedule('0 3 * * *', () => {
  console.log('Loading courses and checking attendance at 03:00...');
  loadCourses();
  checkAttendance();
});

nodeCron.schedule('0 23 * * *', () => {
  console.log('Daily check at 23:00...');
  generateTeacherReports();
});

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);

  // Load courses and check attendance on server start
  loadCourses();
  checkAttendance();
});
