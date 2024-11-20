const socket = io();

let attendanceRecords = [];

// Function to render the table
function renderTable() {
  const tbody = document.querySelector('#attendanceTable tbody');
  tbody.innerHTML = ''; // Clear existing rows

  attendanceRecords.forEach(record => {
    const tr = document.createElement('tr');

    if (record.status === 'Attended') {
      tr.classList.add('attended');
    } else if (record.status === 'Not Attended') {
      tr.classList.add('not-attended');
    } else if (record.status === 'In Progress') {
      tr.classList.add('in-progress');
    } else {
      tr.classList.add('scheduled');
    }

    tr.innerHTML = `
      <td>${record.course_id}</td>
      <td>${record.course_name}</td>
      <td>${record.teacher_name}</td>
      <td>${record.week_day}</td>
      <td>${record.scheduled_time}</td>
      <td>${record.host_id}</td>
      <td>${record.today_date}</td>
      <td>${record.entered_time}</td>
      <td>${record.finished_time}</td>
      <td>${record.total_time}</td>
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
  if (record.course_name) {
    // Remove any existing record for the same course and date
    attendanceRecords = attendanceRecords.filter(
      r =>
        !(
          r.course_name === record.course_name &&
          r.host_id === record.host_id &&
          r.today_date === record.today_date &&
          r.entered_time === record.entered_time
        )
    );
    attendanceRecords.push(record);
    renderTable();
  } else {
    // Refresh data
    socket.emit('requestData');
  }
});
