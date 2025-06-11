require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { pool, tokenHelpers, initDb } = require('./db');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

// Process level error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Keep the process running
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Keep track of server state
let serverState = {
  startTime: null,
  requestCount: 0,
  lastRequest: null
};

// Add request tracking at the top of the file
let requestCount = 0;
const activeRequests = new Map();

const app = express();

// Add timezone mapping at the top of the file
const TIMEZONE_MAP = {
  // US Timezones
  'EDT': 'America/New_York',
  'EST': 'America/New_York',
  'CDT': 'America/Chicago',
  'CST': 'America/Chicago',
  'MDT': 'America/Denver',
  'MST': 'America/Denver',
  'PDT': 'America/Los_Angeles',
  'PST': 'America/Los_Angeles',
  'AKDT': 'America/Anchorage',
  'AKST': 'America/Anchorage',
  'HADT': 'America/Adak',
  'HAST': 'America/Adak',
  'HST': 'Pacific/Honolulu',
  
  // Indian Timezones
  'IST': 'Asia/Kolkata',
  'IST-5:30': 'Asia/Kolkata',
  'IST+5:30': 'Asia/Kolkata',
  'India': 'Asia/Kolkata',
  'Kolkata': 'Asia/Kolkata',
  'Calcutta': 'Asia/Kolkata',
  'Mumbai': 'Asia/Kolkata',
  'Delhi': 'Asia/Kolkata',
  'Chennai': 'Asia/Kolkata',
  'Bangalore': 'Asia/Kolkata'
};

// Initialize database before starting the server
async function startServer() {
  try {
    console.log('Initializing database...');
    await initDb();
    console.log('Database initialized successfully');

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      serverState.startTime = new Date().toISOString();
      console.log(`[${serverState.startTime}] Server is running on port ${PORT}`);
      console.log('Available routes:');
      console.log('GET  /');
      console.log('GET  /ping');
      console.log('GET  /api/test');
      console.log('GET  /api/callback');
    });

    // Handle server errors
    server.on('error', (error) => {
      console.error('Server error:', error);
    });

    // Handle server close
    server.on('close', () => {
      console.log('Server is shutting down...');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Debug middleware - log ALL requests before any other middleware
app.use((req, res, next) => {
  serverState.requestCount++;
  serverState.lastRequest = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Request #${serverState.requestCount}:`, {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    query: req.query,
    headers: req.headers
  });
  next();
});

// Trust proxy for rate limiter
app.set('trust proxy', 1);

// Security middleware - temporarily disable helmet for testing
// app.use(helmet({
//   crossOriginResourcePolicy: { policy: "cross-origin" },
//   crossOriginOpenerPolicy: { policy: "unsafe-none" }
// }));

app.use(cors({
  origin: '*',  // Allow all origins temporarily for testing
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Rate limiting - temporarily disable for testing
// app.use(limiter);

// Health check endpoints
app.get('/', (req, res) => {
  console.log('Root endpoint hit');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    serverState: {
      startTime: serverState.startTime,
      requestCount: serverState.requestCount,
      lastRequest: serverState.lastRequest
    }
  });
});

app.get('/ping', (req, res) => {
  console.log('✅ /ping route was hit');
  res.send('Pong!');
});

// Debug route to test routing
app.get('/api/test', (req, res) => {
  console.log('Test route hit');
  res.send('Test route working');
});

// OAuth callback endpoint
app.get('/api/callback', async (req, res) => {
  console.log('🔔 Callback endpoint hit - START');
  console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
  console.log('Raw query string:', req.url.split('?')[1]);
  console.log('Query params:', req.query);
  console.log('Headers:', req.headers);
  
  const { code } = req.query;

  if (!code) {
    console.error('No authorization code received');
    return res.status(400).send('Authorization code is missing');
  }

  try {
    const tokenRequestParams = {
      grant_type: 'authorization_code',
      client_id: process.env.SALESFORCE_CLIENT_ID,
      client_secret: process.env.SALESFORCE_CLIENT_SECRET,
      redirect_uri: process.env.SALESFORCE_REDIRECT_URI,
      code
    };

    console.log('📡 Requesting tokens from Salesforce...');

    const response = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
      params: tokenRequestParams
    });

    const { access_token, refresh_token, instance_url } = response.data;

    if (!access_token || !refresh_token || !instance_url) {
      console.error('❌ Missing tokens from response:', response.data);
      return res.status(500).send('Invalid response from Salesforce');
    }

    // Store the tokens
    await tokenHelpers.storeTokens({
      access_token,
      refresh_token,
      instance_url
    });

    console.log('✅ Tokens stored successfully');
    return res.send('Salesforce successfully connected!');
  } catch (error) {
    console.error('❌ Salesforce auth error:', {
      message: error.message,
      data: error.response?.data,
      status: error.response?.status
    });
    return res.status(500).send('Salesforce authentication failed. Check logs.');
  }
});

// Get employees from Salesforce
app.get('/api/employees', async (req, res) => {
  try {
    const tokens = await tokenHelpers.getTokens();
    if (!tokens) {
      return res.status(404).json({ error: 'No Salesforce connection found' });
    }

    // Query Salesforce for employees and their clock records
    const response = await axios.get(
      `${tokens.instance_url}/services/data/v59.0/query`,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
        params: {
          q: `
            SELECT 
              Employee_Email__c,
              Employee_Name__c,
              Punch_In_Time__c,
              Punch_Out_Time__c,
              Location_Type__c
            FROM Workpunch__c
            ORDER BY Employee_Email__c, Punch_In_Time__c DESC
          `
        }
      }
    );

    // Group records by employee
    const employeeMap = new Map();
    response.data.records.forEach(record => {
      if (!employeeMap.has(record.Employee_Email__c)) {
        employeeMap.set(record.Employee_Email__c, {
          id: record.Employee_Email__c,
          name: record.Employee_Name__c,
          clockRecords: [],
          totalRemoteHours: 0,
          totalInPersonHours: 0
        });
      }

      const employee = employeeMap.get(record.Employee_Email__c);
      if (record.Punch_In_Time__c) {
        const clockRecord = {
          clockIn: new Date(record.Punch_In_Time__c),
          clockOut: record.Punch_Out_Time__c ? new Date(record.Punch_Out_Time__c) : null,
          isRemote: record.Location_Type__c === 'Remote'
        };
        employee.clockRecords.push(clockRecord);

        // Calculate hours if clocked out
        if (clockRecord.clockOut) {
          const hours = (clockRecord.clockOut - clockRecord.clockIn) / (1000 * 60 * 60);
          if (clockRecord.isRemote) {
            employee.totalRemoteHours += hours;
          } else {
            employee.totalInPersonHours += hours;
          }
        }
      }
    });

    res.json(Array.from(employeeMap.values()));
  } catch (error) {
    console.error('Error fetching employees from Salesforce:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch employees from Salesforce' });
  }
});

// Sync user data endpoint
app.post('/api/sync-user', async (req, res) => {
  try {
    const { id, name, clockRecords, totalRemoteHours, totalInPersonHours } = req.body;

    const tokens = await tokenHelpers.getTokens();
    if (!tokens) {
      return res.status(404).json({ error: 'No Salesforce connection found' });
    }

    // Sync each clock record to Salesforce
    for (const record of clockRecords) {
      const recordPayload = {
        Punch_In_Time__c: record.clockIn,
        Punch_Out_Time__c: record.clockOut,
        Location_Type__c: record.isRemote ? 'Remote' : 'In Office',
        Employee_Email__c: id
      };

      await axios.post(`${tokens.instance_url}/services/data/v59.0/sobjects/Workpunch__c`, recordPayload, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json'
        }
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error syncing user data:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to sync user data to Salesforce' });
  }
});

// Add after other database setup
async function acquireLock(userId) {
  const lockId = uuidv4();
  const result = await pool.query(
    'INSERT INTO user_locks (user_id, lock_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO NOTHING RETURNING lock_id',
    [userId, lockId]
  );
  return result.rows[0]?.lock_id;
}

async function releaseLock(userId) {
  await pool.query('DELETE FROM user_locks WHERE user_id = $1', [userId]);
}

// Modify the sync-clock endpoint
app.post('/api/sync-clock', async (req, res) => {
  const requestId = ++requestCount;
  const { userId, clockIn, clockOut, isRemote, timezone } = req.body;

  console.log(`🔄 [Request ${requestId}] Sync clock request received:`, {
    userId,
    clockIn,
    clockOut,
    isRemote,
    timezone,
    timestamp: new Date().toISOString()
  });

  // Try to acquire a lock
  const lockId = await acquireLock(userId);
  if (!lockId) {
    console.log(`⏭️ [Request ${requestId}] Skipping duplicate request - lock exists`);
    return res.status(200).json({ 
      success: true, 
      message: 'Request already being processed',
      requestId
    });
  }

  try {
    // Get the company tokens from the database
    const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) {
      console.log(`❌ [Request ${requestId}] No company found in database`);
      return res.status(404).json({ error: 'No company found in database' });
    }

    const company = result.rows[0];
    
    // Extract name from email (everything before @)
    const personName = userId.split('@')[0];
    
    // Parse the dates using the phone's local time
    const clockInDate = new Date(clockIn);
    const clockOutDate = clockOut ? new Date(clockOut) : null;

    console.log(`📅 [Request ${requestId}] Parsed dates:`, {
      clockInDate: clockInDate.toLocaleString(),
      clockOutDate: clockOutDate ? clockOutDate.toLocaleString() : null,
      clockInISO: clockInDate.toISOString(),
      clockOutISO: clockOutDate ? clockOutDate.toISOString() : null
    });

    // Validate dates
    if (isNaN(clockInDate.getTime())) {
      console.log(`❌ [Request ${requestId}] Invalid clock in date:`, clockIn);
      return res.status(400).json({ error: 'Invalid clock in date' });
    }
    if (clockOutDate && isNaN(clockOutDate.getTime())) {
      console.log(`❌ [Request ${requestId}] Invalid clock out date:`, clockOut);
      return res.status(400).json({ error: 'Invalid clock out date' });
    }

    // Ensure clock out is after clock in
    if (clockOutDate && clockOutDate <= clockInDate) {
      console.log(`❌ [Request ${requestId}] Clock out time must be after clock in time:`, {
        clockIn: clockInDate.toLocaleString(),
        clockOut: clockOutDate.toLocaleString()
      });
      return res.status(400).json({ error: 'Clock out time must be after clock in time' });
    }
    
    // Format date as YYYY-MM-DD using the phone's local time
    const year = clockInDate.getFullYear();
    const month = String(clockInDate.getMonth() + 1).padStart(2, '0');
    const day = String(clockInDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // Convert timezone abbreviation to IANA format
    const ianaTimezone = TIMEZONE_MAP[timezone] || 'America/New_York'; // Default to Eastern if unknown
    console.log(`🌍 [Request ${requestId}] Using timezone:`, { original: timezone, iana: ianaTimezone });
    
    // If clocking out, find and update the existing record
    if (clockOut) {
      console.log(`🔍 [Request ${requestId}] Looking for existing clock-in record to update...`);
      // Query Salesforce for the most recent record for this user that doesn't have a clock out time
      const queryResponse = await axios.get(
        `${company.salesforce_instance_url}/services/data/v59.0/query`,
        {
          headers: {
            Authorization: `Bearer ${company.salesforce_access_token}`,
          },
          params: {
            q: `
              SELECT Id, Punch_In_Time__c, Name
              FROM Workpunch__c 
              WHERE Employee_Email__c = '${userId}'
              AND Punch_Out_Time__c = null
              ORDER BY Punch_In_Time__c DESC 
              LIMIT 1
            `
          }
        }
      );

      console.log(`📊 [Request ${requestId}] Query response:`, {
        recordCount: queryResponse.data.records?.length || 0,
        records: queryResponse.data.records
      });

      if (queryResponse.data.records && queryResponse.data.records.length > 0) {
        const record = queryResponse.data.records[0];
        const existingClockIn = new Date(record.Punch_In_Time__c);
        
        console.log(`⏰ [Request ${requestId}] Comparing times:`, {
          existingClockIn: existingClockIn.toLocaleString(),
          newClockIn: clockInDate.toLocaleString(),
          timeDifference: Math.abs(existingClockIn - clockInDate)
        });

        // Verify this is the correct record to update
        if (Math.abs(existingClockIn - clockInDate) > 60000) { // More than 1 minute difference
          console.log(`❌ [Request ${requestId}] Clock in time mismatch`);
          return res.status(400).json({ error: 'Clock in time mismatch' });
        }

        // Update the existing record
        const recordId = record.Id;
        console.log(`📝 [Request ${requestId}] Updating record:`, recordId);
        try {
          const updateResponse = await axios.patch(
            `${company.salesforce_instance_url}/services/data/v59.0/sobjects/Workpunch__c/${recordId}`,
            {
              Punch_Out_Time__c: clockOutDate.toISOString()
            },
            {
              headers: {
                Authorization: `Bearer ${company.salesforce_access_token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`✅ [Request ${requestId}] Record updated successfully:`, updateResponse.data);
          return res.status(200).json({ success: true, salesforceId: recordId });
        } catch (error) {
          console.error(`❌ [Request ${requestId}] Failed to update record:`, {
            error: error.message,
            response: error.response?.data
          });
          return res.status(500).json({ error: 'Failed to update record in Salesforce' });
        }
      } else {
        console.log(`❌ [Request ${requestId}] No active clock-in record found to update`);
        return res.status(404).json({ error: 'No active clock-in record found to update' });
      }
    }

    // Only create a new record if we're clocking in
    if (!clockOut) {
      console.log(`🔍 [Request ${requestId}] Checking for existing active clock-in...`);
      // Check if there's already an active clock-in
      const activeCheckResponse = await axios.get(
        `${company.salesforce_instance_url}/services/data/v59.0/query`,
        {
          headers: {
            Authorization: `Bearer ${company.salesforce_access_token}`,
          },
          params: {
            q: `
              SELECT Id, Punch_In_Time__c, Location_Type__c, Name
              FROM Workpunch__c 
              WHERE Employee_Email__c = '${userId}'
              AND Punch_Out_Time__c = null
              ORDER BY Punch_In_Time__c DESC
              LIMIT 1
            `
          }
        }
      );

      console.log(`📊 [Request ${requestId}] Active check response:`, {
        recordCount: activeCheckResponse.data.records?.length || 0,
        records: activeCheckResponse.data.records
      });

      if (activeCheckResponse.data.records && activeCheckResponse.data.records.length > 0) {
        const existingRecord = activeCheckResponse.data.records[0];
        console.log(`ℹ️ [Request ${requestId}] Found existing active clock-in:`, {
          id: existingRecord.Id,
          name: existingRecord.Name,
          punchInTime: existingRecord.Punch_In_Time__c,
          locationType: existingRecord.Location_Type__c
        });

        // Return success with existing record info
        return res.status(200).json({
          success: true,
          message: 'Already clocked in',
          existingRecord: {
            id: existingRecord.Id,
            name: existingRecord.Name,
            punchInTime: existingRecord.Punch_In_Time__c,
            locationType: existingRecord.Location_Type__c
          }
        });
      }

      const recordPayload = {
        Name: `${personName}-${dateStr}`,
        Punch_In_Time__c: clockInDate.toISOString(),
        Punch_Out_Time__c: null,
        Location_Type__c: isRemote ? 'Remote' : 'In Office',
        Employee_Email__c: userId
      };

      console.log(`📝 [Request ${requestId}] Creating new record:`, recordPayload);
      try {
        const response = await axios.post(
          `${company.salesforce_instance_url}/services/data/v59.0/sobjects/Workpunch__c`,
          recordPayload,
          {
            headers: {
              Authorization: `Bearer ${company.salesforce_access_token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`✅ [Request ${requestId}] Record created successfully:`, response.data.id);
        res.status(200).json({ success: true, salesforceId: response.data.id });
      } catch (error) {
        console.error(`❌ [Request ${requestId}] Failed to create record:`, {
          error: error.message,
          response: error.response?.data
        });
        res.status(500).json({ error: 'Failed to create record in Salesforce' });
      }
    }
  } catch (error) {
    console.error(`❌ [Request ${requestId}] Salesforce sync error:`, {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({ error: 'Failed to sync to Salesforce' });
  } finally {
    // Release the lock
    await releaseLock(userId);
  }
});

// Salesforce connection endpoint
app.post('/api/connect-salesforce', async (req, res) => {
  console.log('🔗 Connect Salesforce endpoint hit');

  try {
    // Use fixed auth URL
    const authUrl = 'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=3MVG9rZjd7MXFdLiWCf59z4DCGjghAZlWF7KXeBOX3mOvmrPJNArejq_0VHz1HuSTj.gZZ2KrlSLTekQYmEf8&redirect_uri=https%3A%2F%2Fworkpunch-server.fly.dev%2Fapi%2Fcallback&scope=api%20refresh_token';

    res.json({
      success: true,
      authUrl: authUrl
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// Verify Salesforce connection status
app.get('/api/verify-salesforce-connection', async (req, res) => {
  console.log('🔍 Verify Salesforce connection endpoint hit');

  try {
    const tokens = await tokenHelpers.getTokens();
    
    if (!tokens || !tokens.access_token) {
      console.log('No valid connection found');
      return res.status(200).json({
        connected: false,
        message: 'Not connected to Salesforce'
      });
    }

    console.log('✅ Salesforce connection found');
    return res.status(200).json({
      connected: true,
      message: 'Connected to Salesforce'
    });
  } catch (error) {
    console.error('Error checking Salesforce connection:', error);
    return res.status(500).json({
      connected: false,
      message: 'Error checking connection'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  res.status(500).json({ error: 'Something broke!' });
});

// 404 handler - must be after all other routes
app.use((req, res) => {
  console.log('404 Not Found:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
  res.status(404).send('Not Found');
});

// Start the server
startServer();