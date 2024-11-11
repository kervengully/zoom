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

// Paths to attendance files
const attendanceJsonPath = path.join(__dirname, "attendance.json");
const attendanceCsvPath = path.join(__dirname, "attendance.csv");

// Initialize attendance files if they don't exist
if (!fs.existsSync(attendanceJsonPath)) {
  fs.writeFileSync(attendanceJsonPath, "[]", "utf8");
}

if (!fs.existsSync(attendanceCsvPath)) {
  fs.writeFileSync(attendanceCsvPath, "Course Name,Attended On,Date,Time\n");
}

// CSV writer setup for appending records to CSV file
const csvWriter = createObjectCsvWriter({
  path: attendanceCsvPath,
  header: [
    { id: "topic", title: "Course Name" },
    { id: "attended_on", title: "Attended On" },
    { id: "date", title: "Date" },
    { id: "time", title: "Time" },
  ],
  append: true,
});

// Function to save attendance record to JSON and CSV files
function saveAttendanceRecord(course) {
  const attendanceEntry = {
    topic: course.topic,
    attended_on: course.attended_on,
    date: moment().tz("Europe/London").format("DD.MM.YYYY"),
    time: moment().tz("Europe/London").format("HH:mm"),
  };

  // Save to JSON file
  let attendanceRecords = [];
  try {
    const data = fs.readFileSync(attendanceJsonPath, "utf8");
    attendanceRecords = JSON.parse(data);
  } catch (error) {
    console.error("Error reading attendance.json:", error);
  }

  attendanceRecords.push(attendanceEntry);
  fs.writeFileSync(attendanceJsonPath, JSON.stringify(attendanceRecords, null, 2));

  // Save to CSV file
  csvWriter
    .writeRecords([attendanceEntry])
    .then(() => console.log("Attendance saved to CSV file."))
    .catch((err) => console.error("Error writing to CSV:", err));

  // Emit the new attendance record to the frontend
  io.emit("attendance_update", attendanceEntry);
}

// Function to verify Zoom webhook signature (optional but recommended)
function verifyZoomSignature(req) {
  const signature = req.headers["authorization"];
  if (!signature) return false;

  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(payload)
    .digest("hex");

  return signature === expectedSignature;
}

// Webhook handler for Zoom events
app.post("/webhook", (req, res) => {
  // Optional: Verify Zoom signature for security
  /*
  if (!verifyZoomSignature(req)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  */

  const event = req.body.event;
  const topic = req.body.payload?.object?.topic;
  const actualStartTime = req.body.payload?.object?.start_time;

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

  // Only process meeting.started events
  if (event === "meeting.started" && topic && actualStartTime) {
    const attendedOn = moment.tz(actualStartTime, "Europe/London").format("DD.MM.YYYY [at] HH:mm");

    const attendanceRecord = {
      topic,
      attended_on: attendedOn,
    };

    console.log(`Attendance marked for ${topic} on ${attendedOn}`);

    // Save attendance to JSON and CSV files
    saveAttendanceRecord(attendanceRecord);
  } else {
    console.log(`Unhandled event type or missing data: ${event}`);
  }

  res.status(200).json({ message: "Event logged." });
});

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
