const socket = io();

let attendanceRecords = [];

// Function to render the table
function renderTable() {
  const tbody = document.querySelector('#coursesTable tbody');
  tbody.innerHTML = ''; // Clear existing rows

  attendanceRecords.forEach(record => {
    const tr = document.createElement('tr');
    tr.classList.add(record.status === 'Attended' ? 'attended' : 'not-attended');

    tr.innerHTML = `
      <td>${record.teacher_name}</td>
      <td>${record.email}</td>
      <td>${record.course_name}</td>
      <td>${record.meeting_id}</td>
      <td>${record.scheduled_week_day}</td>
      <td>${record.attended_week_day}</td>
      <td>${record.date}</td>
      <td>${record.scheduled_time}</td>
      <td>${record.entered_time}</td>
      <td>${record.finished_time}</td>
      <td>${record.total_time}</td>
      <td>${record.rate_pound}</td>
      <td>${record.rate_formula}</td>
      <td>${record.calculated_payment}</td>
      <td>${record.approved_payment}</td>
      <td>${record.status}</td>
    `;

    tbody.appendChild(tr);
  });
}

// Handle initial data
socket.on('initialData', data => {
  attendanceRecords = data;
  renderTable();
});

// Handle attendance updates
socket.on('attendanceUpdated', record => {
  // Remove any existing record with the same meeting_id
  attendanceRecords = attendanceRecords.filter(r => r.meeting_id !== record.meeting_id);
  attendanceRecords.push(record);
  renderTable();
});

// Handle meeting started (optional, if you want to show meetings that have just started)
socket.on('meetingStarted', data => {
  // You can implement additional logic here if needed
});
