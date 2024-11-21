require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const nodemailer = require("nodemailer");
const { format, differenceInMinutes, parseISO } = require("date-fns");

const app = express();
const port = process.env.PORT || 3000;
const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const IT_EMAIL = process.env.IT_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// CSV and JSON file paths
const csvFilePath = path.join(__dirname, "attendance.csv");
const coursesFilePath = path.join(__dirname, "courses.json");

// Middleware to parse JSON
app.use(express.json());

// Ensure the CSV file exists and has headers
if (!fs.existsSync(csvFilePath)) {
  console.log("Attendance file does not exist. Creating it...");
  fs.writeFileSync(
    csvFilePath,
    "id,topic,host_id,start_time,end_time,total_time,host_name,rate_pound,payment\n"
  );
  console.log("Attendance file created successfully.");
} else {
  console.log("Attendance file exists. Proceeding...");
}

// Configure SMTP transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Validate Zoom webhook
const validateZoomWebhook = (req) => {
  const message = `v0:${req.headers["x-zm-request-timestamp"]}:${JSON.stringify(req.body)}`;
  const hash = crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
    .update(message)
    .digest("hex");
  const signature = `v0=${hash}`;
  return signature === req.headers["x-zm-signature"];
};

// Load today's courses
let todaysCourses = [];
const loadTodaysCourses = () => {
  console.log("Loading today's courses...");
  try {
    const coursesData = JSON.parse(fs.readFileSync(coursesFilePath, "utf8"));
    const todayWeekDay = format(new Date(), "EEEE");
    todaysCourses = coursesData.courses.filter(
      (course) => course.week_day === todayWeekDay
    );
    console.log("Today's courses loaded:", todaysCourses);
  } catch (err) {
    console.error("Failed to load courses:", err.message);
  }
};

// Update host_name for all matching topics in attendance.csv
const updateHostNameInAttendance = (course) => {
  console.log(
    `Checking attendance for course: ${course.topic} at ${course.scheduled_time}`
  );
  try {
    const attendanceData = fs
      .readFileSync(csvFilePath, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => {
        const [
          id,
          topic,
          host_id,
          start_time,
          end_time,
          total_time,
          host_name,
          rate_pound,
          payment,
        ] = line.split(",");
        return {
          id: id?.trim(),
          topic: topic?.trim(),
          host_id: host_id?.trim(),
          start_time: start_time?.trim(),
          end_time: end_time?.trim(),
          total_time: total_time?.trim(),
          host_name: host_name?.trim(),
          rate_pound: rate_pound?.trim(),
          payment: payment?.trim(),
        };
      })
      .filter((meeting) => meeting.topic && meeting.start_time); // Filter out incomplete rows

    let updated = false;
    const updatedData = attendanceData.map((meeting) => {
      if (meeting.topic === course.topic) {
        meeting.host_name = course.host_name;
        updated = true;
      }
      return meeting;
    });

    if (updated) {
      const updatedCSVData = [
        "id,topic,host_id,start_time,end_time,total_time,host_name,rate_pound,payment",
        ...updatedData.map(
          (meeting) =>
            `${meeting.id},${meeting.topic},${meeting.host_id},${meeting.start_time},${meeting.end_time},${meeting.total_time},${meeting.host_name},${meeting.rate_pound},${meeting.payment}`
        ),
      ].join("\n");

      fs.writeFileSync(csvFilePath, updatedCSVData);
      console.log(
        `Host name updated for all occurrences of topic "${course.topic}" in attendance.csv.`
      );
    } else {
      console.log(`No matching meetings found for course: ${course.topic}.`);
    }
  } catch (err) {
    console.error("Failed to update attendance:", err.message);
  }
};

// Update rate_pound for all matching topics in attendance.csv
const updateRatePoundInAttendance = (course) => {
  console.log(
    `Checking attendance for course: ${course.topic} at ${course.scheduled_time}`
  );
  try {
    const attendanceData = fs
      .readFileSync(csvFilePath, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => {
        const [
          id,
          topic,
          host_id,
          start_time,
          end_time,
          total_time,
          host_name,
          rate_pound,
          payment,
        ] = line.split(",");
        return {
          id: id?.trim(),
          topic: topic?.trim(),
          host_id: host_id?.trim(),
          start_time: start_time?.trim(),
          end_time: end_time?.trim(),
          total_time: total_time?.trim(),
          host_name: host_name?.trim(),
          rate_pound: rate_pound?.trim(),
          payment: payment?.trim(),
        };
      })
      .filter((meeting) => meeting.topic && meeting.start_time); // Filter out incomplete rows

    let updated = false;
    const updatedData = attendanceData.map((meeting) => {
      if (meeting.topic === course.topic) {
        meeting.rate_pound = course.rate_pound;
        updated = true;
      }
      return meeting;
    });

    if (updated) {
      const updatedCSVData = [
        "id,topic,host_id,start_time,end_time,total_time,host_name,rate_pound,payment",
        ...updatedData.map(
          (meeting) =>
            `${meeting.id},${meeting.topic},${meeting.host_id},${meeting.start_time},${meeting.end_time},${meeting.total_time},${meeting.host_name},${meeting.rate_pound},${meeting.payment}`
        ),
      ].join("\n");

      fs.writeFileSync(csvFilePath, updatedCSVData);
      console.log(
        `Rate Pound updated for all occurrences of topic "${course.topic}" in attendance.csv.`
      );
    } else {
      console.log(`No matching meetings found for course: ${course.topic}.`);
    }
  } catch (err) {
    console.error("Failed to update attendance:", err.message);
  }
};

// Schedule daily course checks at 04:00
schedule.scheduleJob("0 4 * * *", () => {
  loadTodaysCourses();
  todaysCourses.forEach((course) => {
    const [hour, minute] = course.scheduled_time.split(":").map(Number);
    schedule.scheduleJob({ hour, minute, tz: "Europe/London" }, () => {
      updateHostNameInAttendance(course);
      updateRatePoundInAttendance(course);
    });
  });
});

// Load courses on server start and set up checks for today's courses
loadTodaysCourses();
todaysCourses.forEach((course) => {
  const [hour, minute] = course.scheduled_time.split(":").map(Number);
  schedule.scheduleJob({ hour, minute, tz: "Europe/London" }, () => {
    updateHostNameInAttendance(course);
    updateRatePoundInAttendance(course);
  });
});

// Zoom webhook endpoint
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", req.body);

  if (!validateZoomWebhook(req)) {
    console.log("Invalid webhook signature.");
    return res.status(400).send("Invalid request");
  }

  const event = req.body.event;
  const payload = req.body.payload?.object;

  if (!payload) {
    console.log("Invalid payload: Missing object.");
    return res.status(400).send("Invalid payload");
  }

  if (event === "meeting.started") {
    console.log("Meeting started event received.");

    if (
      !payload.id ||
      !payload.topic ||
      !payload.host_id ||
      !payload.start_time
    ) {
      console.log(
        "Invalid payload: Missing required fields for meeting.started."
      );
      return res.status(400).send("Invalid payload for meeting.started");
    }

    const meetingData = {
      id: payload.id,
      topic: payload.topic,
      host_id: payload.host_id,
      start_time: payload.start_time,
    };
    fs.appendFileSync(
      csvFilePath,
      `${meetingData.id},${meetingData.topic},${meetingData.host_id},${meetingData.start_time},,,,, \n`
    );
    console.log("Meeting started data saved successfully.");
    res.status(200).send("Meeting started logged");
  } else if (event === "meeting.ended") {
    console.log("Meeting ended event received.");

    if (!payload.id || !payload.start_time || !payload.end_time) {
      console.log(
        "Invalid payload: Missing required fields for meeting.ended."
      );
      return res.status(400).send("Invalid payload for meeting.ended");
    }

    const meetingId = payload.id;
    const startTime = payload.start_time;
    const endTime = payload.end_time;

    const csvData = fs.readFileSync(csvFilePath, "utf8").split("\n");
    const updatedData = csvData
      .map((line) => {
        const fields = line.split(",");
        if (
          fields[0] === meetingId &&
          fields[3]?.trim() === startTime &&
          !fields[4]?.trim()
        ) {
          fields[4] = endTime; // Update end_time column
          const start = parseISO(startTime);
          const end = parseISO(endTime);
          const totalTime = differenceInMinutes(end, start);
          fields[5] = totalTime.toString(); // Update total_time column

          const ratePound = parseFloat(fields[7]?.trim()) || 0; // Retrieve rate_pound
          const payment = ((ratePound / 40) * totalTime).toFixed(2); // Calculate payment
          fields[8] = payment; // Update payment column

          return fields.join(",");
        }
        return line;
      })
      .join("\n");

    fs.writeFileSync(csvFilePath, updatedData);
    console.log(
      `Meeting ended data updated successfully for ID: ${meetingId}. Total time: ${differenceInMinutes(parseISO(endTime), parseISO(startTime))} minutes.`
    );
    res.status(200).send("Meeting ended logged");
  } else {
    console.log(`Unhandled event type: ${event}`);
    res.status(400).send("Event not handled");
  }
});

app.listen(port, () => {
  console.log(`Zoom webhook listener running on port ${port}`);
});
