// File: my_socket_server/server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const mysql = require("mysql2/promise");

require("dotenv").config();

const PHP_API_TOKEN =
  process.env.PHP_TO_NODE_SECRET_TOKEN ||
  "GANTI_DENGAN_KUNCI_RAHASIA_INTERNAL_ANDA";
const JWT_SECRET_KEY_PHP =
  process.env.JWT_SECRET_KEY_FROM_PHP || "GANTI_DENGAN_JWT_SECRET_KEY_PHP_ANDA";
const VUE_APP_ORIGIN = process.env.VUE_APP_ORIGIN || "http://localhost:5173";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: VUE_APP_ORIGIN,
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(cors({ origin: VUE_APP_ORIGIN }));

const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "robot_tifa",
  port: parseInt(process.env.DB_PORT || "8889", 10),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
};
let pool;

async function initializeDbPool() {
  try {
    pool = mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    console.log(
      `[${new Date().toISOString()}] Berhasil membuat koneksi awal ke database MySQL: ${
        dbConfig.database
      }`
    );
    connection.release();
  } catch (error) {
    // ... (error handling sudah ada) ...
    console.error(
      `[${new Date().toISOString()}] GAGAL terhubung ke database MySQL: ${
        error.message
      }`
    );
    console.error(
      "Pastikan konfigurasi DB di .env Node.js sudah benar dan server MySQL berjalan."
    );
    console.error("Detail Konfigurasi DB yang Digunakan:", {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port,
    });
    process.exit(1);
  }
}
initializeDbPool();

function getSevenDayArray(
  results,
  value_key,
  date_key = "log_day",
  default_value = 0
) {
  const output = Array(7).fill(default_value);
  const today = new Date(); // Menggunakan "hari ini" dari server Node.js
  // Set jam ke tengah hari untuk menghindari masalah pergantian hari/DST saat mengurangi hari
  today.setHours(12, 0, 0, 0);

  const dates_map = {};
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today.getTime()); // Buat instance Date baru
    date.setDate(today.getDate() - i); // Kurangi hari dari "today" yang sudah distabilkan
    const dateString = `${date.getFullYear()}-${String(
      date.getMonth() + 1
    ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    dates_map[dateString] = 6 - i; // index 0 = H-6, index 6 = Hari Ini
  }
  // Aktifkan log ini untuk melihat peta tanggal yang dibuat oleh Node.js
  // console.log(`[getSevenDayArray] Peta Tanggal (Node.js time):`, dates_map);

  (results || []).forEach((row) => {
    const day_str = row[date_key]; // Format YYYY-MM-DD dari MySQL
    // Aktifkan log ini untuk melihat setiap baris dari SQL dan bagaimana ia diproses
    // console.log(`[getSevenDayArray] Memproses baris SQL: log_day="${day_str}", ${value_key}="${row[value_key]}"`);
    if (day_str && dates_map.hasOwnProperty(day_str)) {
      const output_idx = dates_map[day_str];
      let val = parseInt(row[value_key], 10); // Gunakan parseInt untuk jumlah/count
      if (isNaN(val)) {
        val = default_value;
      }
      output[output_idx] = val;
    } else {
      // Aktifkan log ini jika tanggal dari SQL tidak ditemukan di peta tanggal Node.js
      // console.log(`[getSevenDayArray] PERINGATAN: Tanggal "${day_str}" dari SQL tidak ditemukan di dates_map atau null.`);
    }
  });
  // Aktifkan log ini untuk melihat output akhir dari getSevenDayArray
  // console.log(`[getSevenDayArray] Output akhir:`, output);
  return output;
}

// ... (lastSentPayloads, getRobotOperationalMetrics tidak berubah, sudah benar) ...
async function getRobotOperationalMetrics(robotId) {
  const [operationDurationData] = await pool.query(
    "SELECT MIN(created_at) AS first_order_time, MAX(created_at) AS last_order_time, COUNT(DISTINCT DATE(created_at)) AS total_active_days FROM orders WHERE robot_id = ?",
    [robotId]
  );

  let operatingTimeInfo = {
    durationText: "N/A",
    totalActiveDays: 0,
  };

  if (
    operationDurationData &&
    operationDurationData.length > 0 &&
    operationDurationData[0].first_order_time
  ) {
    const firstOrder = new Date(operationDurationData[0].first_order_time);
    const lastOrder = new Date(operationDurationData[0].last_order_time);
    operatingTimeInfo.totalActiveDays = parseInt(
      operationDurationData[0].total_active_days || 0,
      10
    );

    if (!isNaN(firstOrder.getTime()) && !isNaN(lastOrder.getTime())) {
      const diffMs = lastOrder - firstOrder;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffHrs = Math.floor(
        (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
      );
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      operatingTimeInfo.durationText = `${diffDays} hari, ${diffHrs} jam, ${diffMins} menit`;
    }
  }

  const [dailyOperationActivityData] = await pool.query(
    "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as operation_day FROM orders WHERE robot_id = ? AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY operation_day ORDER BY operation_day ASC",
    [robotId]
  );

  const processedDailyOperationForChart = (
    dailyOperationActivityData || []
  ).map((dayData) => ({
    log_day: dayData.operation_day,
    is_active: 1,
  }));

  const dailyActiveStatusChart = getSevenDayArray(
    processedDailyOperationForChart,
    "is_active",
    "log_day",
    0
  );

  return { operatingTimeInfo, dailyActiveStatusChart };
}

async function fetchDataForType(type, robotId = null) {
  if (!pool) {
    // ... (error handling sudah ada) ...
    console.error(
      `[${new Date().toISOString()}] DB Pool belum siap saat mencoba fetch data untuk tipe: ${type}`
    );
    return {
      eventName: "stream_error",
      payloadArray: { error: "DB Pool not initialized" },
    };
  }
  let payloadArray = null;
  let eventName = "";

  try {
    if (type === "all_with_logs") {
      eventName = "all_with_logs_update";
      const [robots_from_battery_data] = await pool.query(
        "SELECT id, name, serial, battery_percentage, mode, battery_performance, timestamp FROM battery_data ORDER BY id ASC"
      );
      const robotsOutput = [];
      for (const robot_entry of robots_from_battery_data || []) {
        const robot_id_key = robot_entry.id;
        const { operatingTimeInfo, dailyActiveStatusChart } =
          await getRobotOperationalMetrics(robot_id_key);

        const current_robot_output = {
          id: parseInt(robot_entry.id, 10),
          name: robot_entry.name || "N/A",
          serial: robot_entry.serial || "N/A",
          battery_percentage: parseFloat(
            parseFloat(robot_entry.battery_percentage || 0).toFixed(2)
          ),
          mode: robot_entry.mode || "N/A",
          battery_performance:
            robot_entry.battery_performance !== null
              ? parseInt(robot_entry.battery_performance, 10)
              : null,
          timestamp: robot_entry.timestamp,
          operatingTime: operatingTimeInfo,
          orderLogDetails: [],
          actualChartData: {
            dailyCompletedOrders: [], // Akan diisi di bawah
            dailyAvgBattery: [],
            dailyAvgPerformance: [],
            dailyActiveStatus: dailyActiveStatusChart,
          },
        };
        const [raw_robot_logs] = await pool.query(
          "SELECT o.created_at, o.status, k.table_number FROM orders o LEFT JOIN koor k ON o.koor_id = k.id WHERE o.robot_id = ? ORDER BY o.created_at DESC LIMIT 5",
          [robot_id_key]
        );
        current_robot_output.orderLogDetails = (raw_robot_logs || []).map(
          (log_entry) => {
            const tableNum = log_entry.table_number || "N/A";
            let status_desc = `Status tidak diketahui (${log_entry.status})`;
            switch (parseInt(log_entry.status, 10)) {
              case 0:
                status_desc = `Pesanan baru untuk meja ${tableNum}`;
                break;
              case 1:
                status_desc = `Pesanan meja ${tableNum} selesai diantarkan`;
                break;
              case 2:
                status_desc = `Pesanan meja ${tableNum} selesai diantarkan`;
                break;
            }
            return {
              timestamp_raw: log_entry.created_at,
              description: status_desc,
            };
          }
        );

        // Query untuk dailyCompletedOrders (semua order)
        // console.log(`[DEBUG] Mengambil chart_orders_data untuk robot_id: ${robot_id_key}`); // Aktifkan untuk debug
        const [chart_orders_data] = await pool.query(
          "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as log_day, COUNT(*) as order_count FROM orders WHERE robot_id = ? AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
          [robot_id_key]
        );
        // console.log(`[DEBUG] Robot ID: ${robot_id_key} - Hasil MENTAH chart_orders_data dari SQL:`, JSON.stringify(chart_orders_data, null, 2)); // Aktifkan untuk debug

        const dailyOrdersArray = getSevenDayArray(
          chart_orders_data,
          "order_count"
        );
        // console.log(`[DEBUG] Robot ID: ${robot_id_key} - Hasil PROSES dailyCompletedOrders untuk chart:`, JSON.stringify(dailyOrdersArray, null, 2)); // Aktifkan untuk debug
        current_robot_output.actualChartData.dailyCompletedOrders =
          dailyOrdersArray;

        // ... (query untuk dailyAvgBattery dan dailyAvgPerformance sudah ada dan benar) ...
        const [chart_battery_data] = await pool.query(
          "SELECT DATE_FORMAT(timestamp, '%Y-%m-%d') as log_day, AVG(battery_percentage) as avg_battery FROM battery_data WHERE id = ? AND timestamp >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
          [robot_id_key]
        );
        current_robot_output.actualChartData.dailyAvgBattery = getSevenDayArray(
          chart_battery_data,
          "avg_battery"
        );
        const [chart_performance_data] = await pool.query(
          "SELECT DATE_FORMAT(timestamp, '%Y-%m-%d') as log_day, AVG(CAST(battery_performance AS DECIMAL(5,2))) as avg_performance FROM battery_data WHERE id = ? AND timestamp >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
          [robot_id_key]
        );
        current_robot_output.actualChartData.dailyAvgPerformance =
          getSevenDayArray(chart_performance_data, "avg_performance");

        robotsOutput.push(current_robot_output);
      }
      payloadArray = robotsOutput;
    } else if (type === "single_latest") {
      // ... (kode tidak berubah) ...
      eventName = "single_latest_update";
      const [rows] = await pool.query(
        "SELECT id, name, serial, battery_percentage, mode, battery_performance, timestamp FROM battery_data ORDER BY timestamp DESC LIMIT 1"
      );
      if (rows && rows.length > 0) {
        const row = rows[0];
        payloadArray = {
          id: parseInt(row.id, 10),
          name: row.name || "N/A",
          serial: row.serial || "N/A",
          battery_percentage: parseFloat(
            parseFloat(row.battery_percentage || 0).toFixed(2)
          ),
          mode: row.mode || "N/A",
          battery_performance:
            row.battery_performance !== null
              ? parseInt(row.battery_performance, 10)
              : null,
          timestamp: row.timestamp,
        };
      } else {
        payloadArray = null;
      }
    } else if (type === "all_robots_simple") {
      // ... (kode tidak berubah) ...
      eventName = "all_robots_simple_update";
      const [robotsSimpleRaw] = await pool.query(
        "SELECT id, name, serial, battery_percentage, mode, battery_performance, timestamp FROM battery_data ORDER BY id ASC"
      );
      payloadArray = (robotsSimpleRaw || []).map((r) => ({
        id: parseInt(r.id, 10),
        name: r.name || "N/A",
        serial: r.serial || "N/A",
        battery_percentage: parseFloat(
          parseFloat(r.battery_percentage || 0).toFixed(2)
        ),
        mode: r.mode || "N/A",
        battery_performance:
          r.battery_performance !== null
            ? parseInt(r.battery_performance, 10)
            : null,
        timestamp: r.timestamp,
      }));
    } else if (type === "robot_detail" && robotId) {
      payloadArray = await fetchRobotDetailData(robotId); // fetchRobotDetailData sudah memanggil getRobotOperationalMetrics dan query dailyCompletedOrders yang benar
      if (payloadArray && !payloadArray.error) {
        eventName = `robot_detail_update`;
      } else if (payloadArray && payloadArray.error) {
        eventName = "stream_error";
      }
    } else if (type === "robot_detail" && !robotId) {
      // ... (error handling sudah ada) ...
      eventName = "stream_error";
      payloadArray = { error: "Robot ID tidak diberikan untuk robot_detail." };
    }
    return { eventName, payloadArray };
  } catch (error) {
    // ... (error handling sudah ada) ...
    console.error(
      `[${new Date().toISOString()}] DB Error fetchDataForType (type: ${type}, robotId: ${robotId}):`,
      error.message
    );
    return {
      eventName: "stream_error",
      payloadArray: {
        type: type,
        message: "Database error fetching data for stream.",
      },
    };
  }
}

async function fetchRobotDetailData(robotId) {
  if (!pool) {
    // ... (error handling sudah ada) ...
    console.error(
      `DB Pool not initialized for fetchRobotDetailData (ID: ${robotId})`
    );
    return { error: "DB Pool not initialized" };
  }
  try {
    const [rows] = await pool.query(
      "SELECT id, name, serial, battery_percentage, mode, battery_performance, timestamp FROM battery_data WHERE id = ?",
      [robotId]
    );
    if (rows.length > 0) {
      const robot_data_raw = rows[0];
      const { operatingTimeInfo, dailyActiveStatusChart } =
        await getRobotOperationalMetrics(robotId);

      const robot_data = {
        id: parseInt(robot_data_raw.id, 10),
        name: robot_data_raw.name || "N/A",
        serial: robot_data_raw.serial || "N/A",
        battery_percentage: parseFloat(
          parseFloat(robot_data_raw.battery_percentage || 0).toFixed(2)
        ),
        mode: robot_data_raw.mode || "N/A",
        battery_performance:
          robot_data_raw.battery_performance !== null
            ? parseInt(robot_data_raw.battery_performance, 10)
            : null,
        timestamp: robot_data_raw.timestamp,
        operatingTime: operatingTimeInfo,
        orderLogDetails: [],
        actualChartData: {
          dailyCompletedOrders: [], // Akan diisi di bawah
          dailyAvgBattery: [],
          dailyAvgPerformance: [],
          dailyActiveStatus: dailyActiveStatusChart,
        },
      };
      const [raw_robot_logs] = await pool.query(
        "SELECT o.created_at, o.status, k.table_number FROM orders o LEFT JOIN koor k ON o.koor_id = k.id WHERE o.robot_id = ? ORDER BY o.created_at DESC LIMIT 50",
        [robotId]
      );
      robot_data.orderLogDetails = (raw_robot_logs || []).map((log_entry) => {
        const tableNum = log_entry.table_number || "N/A";
        let status_desc = `Status tidak diketahui (${log_entry.status})`;
        switch (parseInt(log_entry.status, 10)) {
          case 0:
            status_desc = `Pesanan baru untuk meja ${tableNum}`;
            break;
          case 1:
            status_desc = `Pesanan meja ${tableNum} selesai diantarkan`;
            break; // Note: case 1 dan 2 di all_with_logs berbeda dengan ini. Konsistensi mungkin diperlukan.
          case 2:
            status_desc = `Pesanan meja ${tableNum} selesai diantarkan`;
            break;
          case 3:
            status_desc = `Pesanan meja ${tableNum} dibatalkan`;
            break;
        }
        return {
          timestamp_raw: log_entry.created_at,
          description: status_desc,
        };
      });

      // Query untuk dailyCompletedOrders (semua order)
      // console.log(`[DEBUG] Mengambil chart_orders_data untuk robot_id: ${robotId} (dalam fetchRobotDetailData)`); // Aktifkan untuk debug
      const [chart_orders_data] = await pool.query(
        "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as log_day, COUNT(*) as order_count FROM orders WHERE robot_id = ? AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
        [robotId]
      );
      // console.log(`[DEBUG] Robot ID: ${robotId} - Hasil MENTAH chart_orders_data dari SQL (dalam fetchRobotDetailData):`, JSON.stringify(chart_orders_data, null, 2)); // Aktifkan untuk debug

      const dailyOrdersArrayDetail = getSevenDayArray(
        chart_orders_data,
        "order_count"
      );
      // console.log(`[DEBUG] Robot ID: ${robotId} - Hasil PROSES dailyCompletedOrders untuk chart (dalam fetchRobotDetailData):`, JSON.stringify(dailyOrdersArrayDetail, null, 2)); // Aktifkan untuk debug
      robot_data.actualChartData.dailyCompletedOrders = dailyOrdersArrayDetail;

      // ... (query untuk dailyAvgBattery dan dailyAvgPerformance sudah ada dan benar) ...
      const [chart_battery_data] = await pool.query(
        "SELECT DATE_FORMAT(timestamp, '%Y-%m-%d') as log_day, AVG(battery_percentage) as avg_battery FROM battery_data WHERE id = ? AND timestamp >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
        [robotId]
      );
      robot_data.actualChartData.dailyAvgBattery = getSevenDayArray(
        chart_battery_data,
        "avg_battery"
      );
      const [chart_performance_data] = await pool.query(
        "SELECT DATE_FORMAT(timestamp, '%Y-%m-%d') as log_day, AVG(CAST(battery_performance AS DECIMAL(5,2))) as avg_performance FROM battery_data WHERE id = ? AND timestamp >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
        [robotId]
      );
      robot_data.actualChartData.dailyAvgPerformance = getSevenDayArray(
        chart_performance_data,
        "avg_performance"
      );
      return robot_data;
    }
    // ... (error handling sudah ada) ...
    return {
      error: "Data baterai (robot) tidak ditemukan",
      id_requested: robotId,
    };
  } catch (error) {
    // ... (error handling sudah ada) ...
    console.error(
      `[${new Date().toISOString()}] DB Error fetchRobotDetailData for ID ${robotId}:`,
      error.message
    );
    return {
      error: "Database error on server saat mengambil detail robot",
      id_requested: robotId,
    };
  }
}

// ... (endpoint /internal/broadcast, middleware io.use, io.on('connection'), setInterval, httpServer.listen tidak berubah) ...
// Endpoint internal untuk menerima broadcast dari PHP
app.post("/internal/broadcast", (req, res) => {
  const internalToken = req.headers["x-internal-auth-token"];
  if (internalToken !== PHP_API_TOKEN) {
    console.warn(
      `[${new Date().toISOString()}] Broadcast attempt with invalid internal token.`
    );
    return res
      .status(403)
      .send({ status: "error", message: "Forbidden: Invalid internal token" });
  }
  const { eventName, data, room } = req.body;
  if (!eventName || data === undefined) {
    return res
      .status(400)
      .send({ status: "error", message: "eventName and data are required." });
  }
  console.log(
    `[${new Date().toISOString()}] Menerima broadcast dari PHP: event='${eventName}', room='${
      room || "all"
    }'`
  );
  const jsonData = JSON.stringify(data);
  if (jsonData) {
    if (room) {
      io.to(room).emit(eventName, jsonData);
    } else {
      io.emit(eventName, jsonData);
    }
    res.status(200).send({ status: "success", message: "Event broadcasted" });
  } else {
    console.error(
      `[${new Date().toISOString()}] Gagal JSON.stringify data untuk broadcast dari PHP, event: ${eventName}`
    );
    res.status(500).send({
      status: "error",
      message: "Gagal memproses data untuk broadcast.",
    });
  }
});

// Middleware autentikasi Socket.IO
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET_KEY_PHP);
      socket.userData = decoded.data;
      console.log(
        `[${new Date().toISOString()}] Socket ${
          socket.id
        } authenticated: User ${socket.userData.username} (ID: ${
          socket.userData.userId
        })`
      );
      next();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Socket ${
          socket.id
        } authentication error: ${err.message}`
      );
      next(new Error("Authentication error: Invalid token."));
    }
  } else {
    console.warn(
      `[${new Date().toISOString()}] Socket ${
        socket.id
      } connection attempt without token.`
    );
    next(new Error("Authentication error: Token not provided."));
  }
});

io.on("connection", (socket) => {
  console.log(
    `[${new Date().toISOString()}] Klien terhubung: ${socket.id} (User: ${
      socket.userData?.username
    })`
  );
  socket.emit("connection_ack", {
    message: "Berhasil terhubung dan terautentikasi",
    userId: socket.userData?.userId,
  });

  socket.on("request_initial_data", async (request) => {
    if (!socket.userData) {
      socket.emit(
        "stream_error",
        JSON.stringify({ message: "Tidak terautentikasi untuk meminta data." })
      );
      return;
    }
    const type = request.type || "all_robots_simple";
    const robotId = request.id ? parseInt(request.id, 10) : null;

    console.log(
      `[${new Date().toISOString()}] Klien ${socket.id} (User: ${
        socket.userData.username
      }) meminta initial_data type: ${type}` +
        (robotId ? `, ID: ${robotId}` : "")
    );

    const result = await fetchDataForType(type, robotId);

    if (result && result.payloadArray && result.eventName) {
      const jsonData = JSON.stringify(result.payloadArray);
      if (jsonData) {
        if (type === "robot_detail" && robotId && !result.payloadArray.error) {
          socket.emit("robot_detail_update", jsonData);
        } else if (result.payloadArray.error) {
          socket.emit("stream_error", jsonData);
        } else {
          socket.emit(result.eventName, jsonData);
        }
      } else {
        console.error(
          `[${new Date().toISOString()}] Gagal JSON.stringify data awal untuk klien ${
            socket.id
          }, type: ${type}`
        );
        socket.emit(
          "stream_error",
          JSON.stringify({ message: "Gagal encode data awal." })
        );
      }
    } else if (result && result.payloadArray === null && result.eventName) {
      socket.emit(result.eventName, JSON.stringify(null));
    } else {
      console.warn(
        `[${new Date().toISOString()}] Tidak ada data atau event name untuk dikirim ke klien ${
          socket.id
        } untuk initial_data type: ${type}`
      );
      if (result && result.eventName) {
        socket.emit(result.eventName, JSON.stringify(null));
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(
      `[${new Date().toISOString()}] Klien terputus: ${
        socket.id
      }. Alasan: ${reason}`
    );
  });
});

// Timer periodik
setInterval(async () => {
  if (Object.keys(io.sockets.sockets).length === 0) {
    return;
  }

  const typesToBroadcast = [
    "all_robots_simple",
    "all_with_logs",
    "single_latest",
  ];
  for (const type of typesToBroadcast) {
    const result = await fetchDataForType(type);

    if (
      result &&
      result.payloadArray &&
      result.eventName &&
      !result.payloadArray.error
    ) {
      const encoded = JSON.stringify(result.payloadArray);
      if (!encoded) {
        console.error(
          `[${new Date().toISOString()}] Timer: Gagal JSON.stringify untuk tipe ${type}`
        );
        continue;
      }

      let lastSentJson = lastSentPayloads[type];

      if (type === "single_latest") {
        lastSentJson = lastSentPayloads.single_latest
          ? JSON.stringify(lastSentPayloads.single_latest)
          : null;
      }

      if (encoded !== lastSentJson) {
        io.emit(result.eventName, encoded);
        if (type === "single_latest") {
          lastSentPayloads.single_latest = result.payloadArray;
        } else {
          lastSentPayloads[type] = encoded;
        }
      }
    }
  }
}, 3000);

const PORT = process.env.SOCKET_IO_PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(
    `Server Socket.IO (Node.js) berjalan di http://localhost:${PORT}`
  );
});
