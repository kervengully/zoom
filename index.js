require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const { Server } = require("socket.io");
const http = require("http");
const moment = require("moment-timezone");
const { createObjectCsvWriter } = require("csv-writer");
const path = require("path");

const app = express();
const port = process.env.PORT || 3600;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Paths to files
const attendanceJsonPath = path.join(__dirname, "attendance.json");
const attendanceCsvPath = path.join(__dirname, "attendance.csv");
const coursesJsonPath = path.join(__dirname, "courses.json");

// Initialize attendance files if they don't exist
if (!fs.existsSync(attendanceJsonPath)) {
  fs.writeFileSync(attendanceJsonPath, "[]", "utf8");
}

// CSV writer setup for appending records to CSV file
const csvWriter = createObjectCsvWriter({
  path: attendanceCsvPath,
  header: [
    { id: "teacher_name", title: "Teacher Name" },
    { id: "course_name", title: "Course Name" },
    { id: "meeting_id", title: "Meeting ID" },
    { id: "scheduled_week_day", title: "Scheduled Week Day" },
    { id: "attended_week_day", title: "Attended Week Day" },
    { id: "date", title: "Date" },
    { id: "scheduled_time", title: "Scheduled Time" },
    { id: "entered_time", title: "Entered Time" },
    { id: "finished_time", title: "Finished Time" },
    { id: "total_time", title: "Total Time (minutes)" },
    { id: "rate_pound", title: "Rate (£)" },
    { id: "rate_formula", title: "Rate Formula" },
    { id: "calculated_payment", title: "Calculated Payment (£)" },
    { id: "approved_payment", title: "Approved Payment (£)" },
    { id: "status", title: "Status" }, // Added new column
  ],
  append: true,
});

// Load courses data
let courses = [];
try {
  const coursesData = fs.readFileSync(coursesJsonPath, "utf8");
  const coursesJson = JSON.parse(coursesData);
  courses = coursesJson.courses;
} catch (error) {
  console.error("Error reading courses.json:", error);
}

// In-memory store for ongoing meetings
const ongoingMeetings = {};

// Function to save attendance record to JSON and CSV files
function saveAttendanceRecord(record) {
  // Save to JSON file
  let attendanceRecords = [];
  try {
    const data = fs.readFileSync(attendanceJsonPath, "utf8");
    attendanceRecords = JSON.parse(data);
  } catch (error) {
    console.error("Error reading attendance.json:", error);
  }

  attendanceRecords.push(record);
  fs.writeFileSync(attendanceJsonPath, JSON.stringify(attendanceRecords, null, 2));

  // Save to CSV file
  csvWriter
    .writeRecords([record])
    .then(() => console.log("Attendance saved to CSV file."))
    .catch((err) => console.error("Error writing to CSV:", err));

  // Emit the new attendance record to the frontend
  io.emit("attendance_update", record);
}

// Webhook handler for Zoom events
app.post("/webhook", (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload.object;

  // Handle Zoom endpoint validation
  if (event === "endpoint.url_validation") {
    const plainToken = req.body.payload.plainToken;
    const encryptedToken = crypto
      .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest("hex");

    return res.status(200).json({
      plainToken,
      encryptedToken,
    });
  }

  // Handle meeting.started event
  if (event === "meeting.started") {
    const meetingId = payload.id;
    const topic = payload.topic;
    const startTime = payload.start_time;

    // Store the start time of the meeting
    ongoingMeetings[meetingId] = {
      topic,
      startTime,
      hostId: payload.host_id, // Store host ID if needed
    };

    console.log(`Meeting started: ID ${meetingId}, Topic: ${topic}`);
  }

  // Handle meeting.ended event
  else if (event === "meeting.ended") {
    const meetingId = payload.id;
    const endTime = payload.end_time;

    if (ongoingMeetings[meetingId]) {
      const { topic, startTime } = ongoingMeetings[meetingId];

      // Calculate total time in minutes
      const start = moment(startTime);
      const end = moment(endTime);
      const totalTime = end.diff(start, "minutes");

      // Use the meeting title as course_name
      const courseName = topic;

      // Find the course matching the course_name
      const course = courses.find((c) => c.course_name === courseName);

      if (!course) {
        console.error(`No course found for course_name: ${courseName}`);
        return res.status(200).json({ message: "No matching course found." });
      }

      // Prepare attendance record
      const teacherName = course.teacher_name;
      const scheduledWeekDay = course.scheduled_week_day;
      const scheduledTime = course.scheduled_time;
      const ratePound = course.rate_pound;

      const enteredTime = moment(startTime).tz("Europe/London").format("HH:mm");
      const finishedTime = moment(endTime).tz("Europe/London").format("HH:mm");
      const date = moment(startTime).tz("Europe/London").format("DD.MM.YYYY");
      const attendedWeekDay = moment(startTime).tz("Europe/London").format("dddd");

      const rateFormula = ratePound / 40;
      const calculatedPayment = rateFormula * totalTime;
      const approvedPayment = Math.min(calculatedPayment, ratePound);

      // Determine status based on start time
      // Calculate scheduled date and time
      const scheduledDateTime = getScheduledDateTime(
        startTime,
        scheduledWeekDay,
        scheduledTime
      );

      const scheduledStartTime = moment(scheduledDateTime).subtract(3, "minutes");

      let status = "Attended";

      // If the host didn't start the meeting at least 3 minutes before scheduled_time
      if (moment(startTime).isSameOrAfter(scheduledStartTime)) {
        status = "Not attended";
      }

      const attendanceRecord = {
        teacher_name: teacherName,
        course_name: courseName,
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
        status, // Include status in the record
      };

      console.log(`Attendance recorded for meeting ID ${meetingId}`);

      // Save attendance to JSON and CSV files
      saveAttendanceRecord(attendanceRecord);

      // Remove the meeting from ongoing meetings
      delete ongoingMeetings[meetingId];
    } else {
      console.error(`No ongoing meeting found for ID: ${meetingId}`);
    }
  } else {
    console.log(`Unhandled event type: ${event}`);
  }

  res.status(200).json({ message: "Event processed." });
});

// Function to get the scheduled date and time
function getScheduledDateTime(actualStartTime, scheduledWeekDay, scheduledTime) {
  // Convert scheduledWeekDay to a number (0=Sunday, 1=Monday, ..., 6=Saturday)
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

  // Get the week of the actual start time
  const actualStartMoment = moment(actualStartTime).tz("Europe/London");
  const weekStart = actualStartMoment.clone().startOf("week");

  // Find the scheduled date
  const scheduledDateTime = weekStart
    .add(scheduledWeekDayNum, "days")
    .set({
      hour: parseInt(scheduledTime.split(":")[0], 10),
      minute: parseInt(scheduledTime.split(":")[1], 10),
      second: 0,
      millisecond: 0,
    });

  // If the scheduled date is before the actual start time by more than 6 days, add 7 days
  if (scheduledDateTime.diff(actualStartMoment, "days") < -6) {
    scheduledDateTime.add(7, "days");
  }

  // If the scheduled date is after the actual start time by more than 6 days, subtract 7 days
  if (scheduledDateTime.diff(actualStartMoment, "days") > 6) {
    scheduledDateTime.subtract(7, "days");
  }

  return scheduledDateTime;
}

// Endpoint to fetch all attendance records
app.get("/attendance", (req, res) => {
  try {
    const data = fs.readFileSync(attendanceJsonPath, "utf8");
    const attendanceRecords = JSON.parse(data);
    res.json(attendanceRecords);
  } catch (error) {
    console.error("Error reading attendance.json:", error);
    res.status(500).json({ message: "Failed to read attendance records." });
  }
});

// Start the server
server.listen(port, () => console.log(`Server running on port ${port}!`));
