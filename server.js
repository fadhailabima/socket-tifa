// File: my_socket_server/server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const mysql = require("mysql2/promise"); // Untuk koneksi MySQL

// Konfigurasi dari environment variables
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

// Konfigurasi Koneksi Database MySQL
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
  const today = new Date();
  const dates_map = {};
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateString = `${date.getFullYear()}-${String(
      date.getMonth() + 1
    ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    dates_map[dateString] = 6 - i;
  }

  (results || []).forEach((row) => {
    // Pastikan results adalah array
    const day_str = row[date_key];
    if (day_str && dates_map.hasOwnProperty(day_str)) {
      const output_idx = dates_map[day_str];
      output[output_idx] = parseFloat(
        parseFloat(row[value_key] || default_value).toFixed(2)
      );
    }
  });
  return output;
}

// Variabel untuk menyimpan data terakhir yang dikirim
const lastSentPayloads = {
  all_with_logs: "",
  single_latest: null,
  all_robots_simple: "",
  robot_detail: {}, // Menggunakan objek untuk menyimpan per ID: { "data_ROBOTID": payload, "error_ROBOTID": payload }
};

// --- Fungsi Pengambilan Data (Adaptasi dari logika di StreamController PHP) ---
async function fetchDataForType(type, robotId = null) {
  if (!pool) {
    console.error(
      `[${new Date().toISOString()}] DB Pool belum siap saat mencoba fetch data untuk tipe: ${type}`
    );
    return {
      eventName: "stream_error",
      payloadArray: { error: "DB Pool not initialized" },
    };
  }
  let payloadArray = null;
  let eventName = ""; // Nama event Socket.IO yang akan di-emit

  try {
    if (type === "all_with_logs") {
      eventName = "all_with_logs_update";
      const [robots_from_battery_data] = await pool.query(
        "SELECT id, name, serial, battery_percentage, mode, battery_performance, timestamp FROM battery_data ORDER BY id ASC"
      );
      const robotsOutput = [];
      for (const robot_entry of robots_from_battery_data || []) {
        const robot_id_key = robot_entry.id;
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
          orderLogDetails: [],
          actualChartData: {
            dailyCompletedOrders: [],
            dailyAvgBattery: [],
            dailyAvgPerformance: [],
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
            }
            return {
              timestamp_raw: log_entry.created_at,
              description: status_desc,
            };
          }
        );
        const [chart_orders_data] = await pool.query(
          "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as log_day, COUNT(*) as order_count FROM orders WHERE robot_id = ? AND status = 2 AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
          [robot_id_key]
        );
        current_robot_output.actualChartData.dailyCompletedOrders =
          getSevenDayArray(chart_orders_data, "order_count");
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
        payloadArray = null; // Tidak ada data
      }
    } else if (type === "all_robots_simple") {
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
      // Untuk robot_detail, kita akan memanggil fungsi spesifiknya
      // eventName akan diset di dalam fetchRobotDetailData jika perlu (atau dikirim ke room tertentu)
      payloadArray = await fetchRobotDetailData(robotId); // fetchRobotDetailData akan mengembalikan objek data atau objek error
      if (payloadArray && !payloadArray.error) {
        eventName = `robot_detail_update_${robotId}`; // Event name spesifik per robot ID
      } else if (payloadArray && payloadArray.error) {
        eventName = "stream_error"; // Atau event error spesifik
      }
    } else if (type === "robot_detail" && !robotId) {
      eventName = "stream_error";
      payloadArray = { error: "Robot ID tidak diberikan untuk robot_detail." };
    }
    return { eventName, payloadArray };
  } catch (error) {
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
        orderLogDetails: [],
        actualChartData: {
          dailyCompletedOrders: [],
          dailyAvgBattery: [],
          dailyAvgPerformance: [],
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
            status_desc = `Mengantarkan pesanan ke meja ${tableNum}`;
            break;
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
      const [chart_orders_data] = await pool.query(
        "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as log_day, COUNT(*) as order_count FROM orders WHERE robot_id = ? AND status = 2 AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY log_day ORDER BY log_day ASC",
        [robotId]
      );
      robot_data.actualChartData.dailyCompletedOrders = getSevenDayArray(
        chart_orders_data,
        "order_count"
      );
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
    return {
      error: "Data baterai (robot) tidak ditemukan",
      id_requested: robotId,
    };
  } catch (error) {
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
      `[${new Date().toISOString()}] Gagal json_encode data untuk broadcast dari PHP, event: ${eventName}`
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

  // Klien bisa meminta data awal setelah terhubung dan terautentikasi
  socket.on("request_initial_data", async (request) => {
    if (!socket.userData) {
      // Pastikan sudah terautentikasi
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
      if (result.payloadArray.error) {
        // Jika fungsi fetch mengembalikan objek error
        socket.emit("stream_error", JSON.stringify(result.payloadArray));
      } else {
        const jsonData = JSON.stringify(result.payloadArray);
        if (jsonData) {
          socket.emit(result.eventName, jsonData); // Kirim hanya ke socket yang meminta
        } else {
          console.error(
            `[${new Date().toISOString()}] Gagal json_encode data awal untuk klien ${
              socket.id
            }, type: ${type}`
          );
          socket.emit(
            "stream_error",
            JSON.stringify({ message: "Gagal encode data awal." })
          );
        }
      }
    } else if (result && result.payloadArray === null && result.eventName) {
      // Tidak ada data tapi eventName ada
      socket.emit(result.eventName, JSON.stringify([])); // Kirim array kosong jika diharapkan array
    } else {
      console.warn(
        `[${new Date().toISOString()}] Tidak ada data atau event name untuk dikirim ke klien ${
          socket.id
        } untuk initial_data type: ${type}`
      );
      if (result && result.eventName) {
        // Jika eventName ada tapi payload null
        socket.emit(result.eventName, JSON.stringify(null)); // Kirim null jika itu yang sesuai
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

// Timer periodik untuk mengirim pembaruan data ke semua klien
setInterval(async () => {
  if (Object.keys(io.sockets.sockets).length === 0) {
    // Hanya proses jika ada klien terhubung
    // console.log(`[${new Date().toISOString()}] Timer: Tidak ada klien terhubung, skip broadcast.`);
    return;
  }
  // console.log(`[${new Date().toISOString()}] Timer: Memeriksa pembaruan data untuk disiarkan...`);

  const typesToBroadcast = [
    "all_robots_simple",
    "all_with_logs",
    "single_latest",
  ];
  for (const type of typesToBroadcast) {
    const result = await fetchDataForType(type); // robotId tidak relevan untuk broadcast global ini

    if (
      result &&
      result.payloadArray &&
      result.eventName &&
      !result.payloadArray.error
    ) {
      const encoded = JSON.stringify(result.payloadArray);
      if (!encoded) {
        console.error(
          `[${new Date().toISOString()}] Timer: Gagal json_encode untuk tipe ${type}`
        );
        continue; // Lanjut ke tipe berikutnya jika encoding gagal
      }

      let comparisonKey = type;
      let lastSentJson = lastSentPayloads[type];

      if (type === "single_latest") {
        // Untuk single_latest, payloadArray adalah objek tunggal.
        // lastSentPayloads.single_latest menyimpan objek, jadi kita encode untuk perbandingan.
        lastSentJson = lastSentPayloads.single_latest
          ? JSON.stringify(lastSentPayloads.single_latest)
          : null;
      }

      if (encoded !== lastSentJson) {
        io.emit(result.eventName, encoded); // Siarkan ke semua klien
        if (type === "single_latest") {
          lastSentPayloads.single_latest = result.payloadArray; // Simpan objeknya
        } else {
          lastSentPayloads[type] = encoded; // Simpan JSON string
        }
        console.log(
          `[${new Date().toISOString()}] Timer: Emitted ${
            result.eventName
          } ke ${Object.keys(io.sockets.sockets).length} klien`
        );
      }
    }
  }
}, 3000); // Setiap 3 detik

const PORT = process.env.SOCKET_IO_PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(
    `Server Socket.IO (Node.js) berjalan di http://localhost:${PORT}`
  );
});
