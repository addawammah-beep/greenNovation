const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "db.env") });
const analyzeImage = require("./gemini");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const bodyParser = require('body-parser');
const express = require('express');
const cors = require('cors');
const {Pool} = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { calculatePoints, verifyArrival, reconcileWeights } = require('./domain');
const app = express();
const REPORT_IMAGE_DIR = path.join(__dirname, "report-images");
const REPORT_IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
};

app.use(express.json({ limit: "10mb" })); // Allow profile images stored as data URLs
app.use(cors());

// ================= Upload Configuration =================

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

app.use("/uploads", express.static("uploads"));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },

    filename: (req, file, cb) => {
        cb(
            null,
            Date.now() +
            "-" +
            Math.round(Math.random() * 1000000) +
            path.extname(file.originalname)
        );
    },
}); 


const upload = multer({
    storage,

    limits: {
        fileSize: 10 * 1024 * 1024,
    },

    fileFilter: (req, file, cb) => {

        const allowed = [
            "image/jpeg",
            "image/png",
            "image/jpg",
            "image/webp",
        ];

        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed."));
        }
    },
});

const reportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Only image files are allowed."));
    },
});

const PORT = 4000;
// const userCode = "";
// let resultt=0;

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('JWT_SECRET is not configured. Set it before deploying Greenovation.');

const signToken = (user, role) => jwt.sign(
    { sub: user.id, role, email: user.email },
    JWT_SECRET || 'development-only-secret',
    { expiresIn: '8h' }
);

const authenticate = (req, res, next) => {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        req.auth = jwt.verify(token, JWT_SECRET || 'development-only-secret');
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
};

const authorize = (...roles) => (req, res, next) => {
    const role = req.auth?.role === 'seller' ? 'merchant' : req.auth?.role;
    if (!roles.includes(role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
};

const audit = async (client, event) => {
    await client.query(
        `INSERT INTO audit_events
         (actor_id, actor_role, action, entity_type, entity_id, previous_value, new_value, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [event.actorId || null, event.actorRole || null, event.action, event.entityType,
            String(event.entityId || ''), event.previousValue || null, event.newValue || null, event.metadata || null]
    );
};

const enqueueNotification = async (client, event) => {
    await client.query(
        `INSERT INTO notification_outbox (recipient_id, recipient_role, event_type, entity_type, entity_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.recipientId, event.recipientRole, event.eventType, event.entityType || null, String(event.entityId || ''), event.payload || {}]
    );
};

const processNotificationOutbox = async () => {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const pending = await client.query(`SELECT * FROM notification_outbox
            WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 25`);
        for (const event of pending.rows) {
            await client.query(`INSERT INTO notifications (recipient_id, recipient_role, event_type, entity_type, entity_id, payload)
                VALUES ($1, $2, $3, $4, $5, $6)`, [event.recipient_id, event.recipient_role, event.event_type, event.entity_type, event.entity_id, event.payload]);
            await client.query(`UPDATE notification_outbox SET status = 'sent', attempts = attempts + 1, processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [event.id]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Notification outbox processing failed:', error.message);
    } finally { client.release(); }
};



// User signup endpoint
app.post('/users', async (req, res) => {
    const { email, password, phone, type ,registry, gps, name} = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        if (type === 'user') {
            const result = await db.query(
                'INSERT INTO users (email, password, phone,name, balance, points) VALUES ($1, $2, $3, $4, 0, 0) RETURNING *',
                [email, hashedPassword, phone,name]
            );
            const { password: _password, ...safeUser } = result.rows[0];
            res.json({ success: true, user: safeUser });
         }
        else if (type === 'seller') {
            // Validate GPS coordinates
            if (!gps || gps.split(',').length !== 2) {
                return res.status(400).json({ error: 'Invalid GPS coordinates format. Expected: latitude,longitude' });
            }
            
            const [lat, lng] = gps.split(',');
            const result = await db.query(
                `INSERT INTO sellers (email, password, phone, name, registry, commercial_registration_number,
                    tax_registration_number, business_address, legal_name, business_activity, branch_name,
                    branch_address, responsible_person, gps, points, account_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, POINT($15, $14), 0, 'PENDING_VERIFICATION') RETURNING *`,
                [email, hashedPassword, phone, name, registry, req.body.commercial_registration_number,
                    req.body.tax_registration_number, req.body.business_address, req.body.legal_name,
                    req.body.business_activity, req.body.branch_name, req.body.branch_address,
                    req.body.responsible_person, gps.split(',')[0] || '0', gps.split(',')[1] || '0']
            );
            const { password: _password, ...safeSeller } = result.rows[0];
            res.json({ success: true, seller: safeSeller });
        } else if (type === 'collector') {
            // Validate GPS coordinates
            if (!gps || gps.split(',').length !== 2) {
                return res.status(400).json({ error: 'Invalid GPS coordinates format. Expected: latitude,longitude' });
            }
            
            const [lat, lng] = gps.split(',');
            const result = await db.query(
                'INSERT INTO collectors (email, password, phone,name, registry, gps, points) VALUES ($1, $2, $3, $4, $5, POINT($6, $7), 0) RETURNING *',
                [email, hashedPassword, phone, name, registry, gps.split(',')[1] || '0', gps.split(',')[0] || '0']
            );
            const { password: _password, ...safeCollector } = result.rows[0];
            res.json({ success: true, collector: safeCollector });
        }
    } catch (error) {
        console.error('Error in signup:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Public, read-only collector profile. Never expose credentials.
app.get('/api/collectors/:id/public', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT c.id, c.name, c.age, c.phone, c.location_name, c.profile_image,
                    COUNT(r.id) FILTER (WHERE r.status = 'completed')::INTEGER AS completed_orders,
                    TRUE AS is_active
             FROM collectors c
             LEFT JOIN requests r ON r.collector_id = c.id
             WHERE c.id = $1
             GROUP BY c.id, c.name, c.age, c.phone, c.location_name, c.profile_image`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Collector not found' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching public collector profile:', error);
        res.status(500).json({ error: 'Failed to fetch collector profile' });
    }
});

app.post('/users/login', async (req, res) => {
  const { email, password, type} = req.body;

  if (!email ||!password ||!type) {
    return res.status(400).json({ error: 'Missing login credentials'});
}

  try {
    let result;

    if (type === 'user') {
      result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
} else if (type === 'seller') {
      result = await db.query('SELECT * FROM sellers WHERE email = $1', [email]);
} else if (type === 'collector') {
      result = await db.query('SELECT * FROM collectors WHERE email = $1', [email]);
} else {
      return res.status(400).json({ error: 'Invalid account type'});
}

    if (!result || result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials'});
}

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials'});
    }

    const role = type === 'seller' ? 'merchant' : type;
    const { password: _password, ...safeUser } = user;
    res.json({ success: true, user: safeUser, token: signToken(user, role), role });
} catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ error: 'Login failed'});
}
});

app.put('/collectors/:id/profile', async (req, res) => {
    const { id } = req.params;
    const { name, phone, registry, gps, location_name, profile_image } = req.body;

    try {
        const result = await db.query(
            `UPDATE collectors
             SET name = COALESCE($1, name),
                     phone = COALESCE($2, phone),
                     registry = COALESCE($3, registry),
                     gps = COALESCE($4, gps),
                     location_name = COALESCE($5, location_name),
                     profile_image = COALESCE($6, profile_image)
             WHERE id = $7
             RETURNING *`,
            [name, phone, registry, gps, location_name, profile_image, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Collector not found' });
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('Error updating collector profile:', error);
        res.status(500).json({ error: 'Failed to update collector profile' });
    }
});

app.put('/accounts/:type/:id/profile', async (req, res) => {
    const tableByType = { user: 'users', seller: 'sellers', collector: 'collectors' };
    const accountType = req.params.type;
    const table = tableByType[accountType];
    const { id } = req.params;
    const {
        name, phone, registry, profile_image, password,
        commercial_registration_number, tax_registration_number,
        business_address, legal_name, business_activity, branch_name,
        branch_address, responsible_person
    } = req.body;

    if (!table) return res.status(400).json({ error: 'Invalid account type' });

    try {
        let values;
        let profileFields;
        if (accountType === 'user') {
            values = [name, phone, profile_image, id];
            profileFields = 'name = COALESCE($1, name), phone = COALESCE($2, phone), profile_image = COALESCE($3, profile_image)';
        } else if (accountType === 'collector') {
            values = [name, phone, registry, profile_image, id];
            profileFields = 'name = COALESCE($1, name), phone = COALESCE($2, phone), registry = COALESCE($3, registry), profile_image = COALESCE($4, profile_image)';
        } else {
            const passwordHash = password ? await bcrypt.hash(password, 10) : null;
            values = [
                name, phone, commercial_registration_number, tax_registration_number,
                business_address, legal_name, business_activity, branch_name,
                branch_address, responsible_person, passwordHash, profile_image, id
            ];
            profileFields = `name = COALESCE($1, name),
                phone = COALESCE($2, phone),
                commercial_registration_number = COALESCE($3, commercial_registration_number),
                tax_registration_number = COALESCE($4, tax_registration_number),
                business_address = COALESCE($5, business_address),
                legal_name = COALESCE($6, legal_name),
                business_activity = COALESCE($7, business_activity),
                branch_name = COALESCE($8, branch_name),
                branch_address = COALESCE($9, branch_address),
                responsible_person = COALESCE($10, responsible_person),
                password = COALESCE($11, password),
                profile_image = COALESCE($12, profile_image)`;
        }
        const result = await db.query(
            `UPDATE ${table}
             SET ${profileFields}
             WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
        const { password: _password, ...safeUser } = result.rows[0];
        res.json({ success: true, user: safeUser });
    } catch (error) {
        console.error('Error updating account profile:', error);
        res.status(500).json({ error: error.message || 'Failed to update account profile' });
    }
});

// جلب طلبات المستخدم
app.get('/users/:id/requests', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM requests WHERE user_id = $1',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// جلب جامعي التاجر
app.get('/sellers/:id/collectors', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM collectors WHERE collector_id = $1',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collectors' });
  }
});

// Requests endpoints
app.get('/api/requests/all', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM requests ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching all requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

app.get('/api/requests/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(`
            SELECT r.*, 
                   c.name as collector_name, 
                    c.profile_image as collector_profile_image,
                    CASE WHEN r.status IN ('in_progress', 'completion_pending', 'completed')
                            THEN c.phone ELSE NULL END as collector_phone,
                       COALESCE((SELECT json_agg(json_build_object(
                           'id', candidate.collector_id,
                           'name', candidate_collector.name,
                           'profile_image', candidate_collector.profile_image
                       ) ORDER BY candidate.created_at)
                       FROM request_collector_candidates candidate
                       JOIN collectors candidate_collector ON candidate_collector.id = candidate.collector_id
                       WHERE candidate.request_id = r.id), '[]') as collector_candidates
            FROM requests r 
            LEFT JOIN collectors c ON r.collector_id = c.id 
            WHERE r.user_id = $1 
            ORDER BY r.created_at DESC
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

app.post('/api/requests', async (req, res) => {
    try {
        console.log('Request body received:', req.body);
        
        const { user_id, weight, location, description, gps, material_type } = req.body;
        
        console.log('Extracted data:', { user_id, weight, location, description, gps , material_type});
        
        const gpsValues = String(gps || '').split(',').map(value => Number(value.trim()));
        if (!user_id || !weight || !location || !material_type || gpsValues.length !== 2 || gpsValues.some(value => !Number.isFinite(value))) {
            return res.status(400).json({ error: 'Material, pickup location, valid pickup GPS, and weight are required' });
        }
        
        let query, values;
        
        if (gps && gps.split(',').length === 2) {
            const [lat, lng] = gps.split(',');
            query = 'INSERT INTO requests (user_id, weight, location, description, gps,material_type, status, created_at) VALUES ($1, $2, $3, $4, POINT($6, $5), $7, $8, CURRENT_TIMESTAMP) RETURNING *';
            values = [user_id, weight, location, description || null, lat.trim(), lng.trim(), material_type, 'pending'];
        }

        
        console.log('Executing query:', query);
        console.log('With values:', values);
        
        const result = await db.query(query, values);
        
        res.json({ success: true, request: result.rows[0] });
    } catch (error) {
        console.error('Error creating request:', error);
        res.status(500).json({ error: 'Failed to create request' });
    }
});

// Collectors endpoints
app.get('/api/requests/all', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM requests ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching all requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

app.put('/api/requests/collect', async (req, res) => {
    try {
        const { request_id, collector_id, collector_location } = req.body;

        if (!request_id || !collector_id) {
            return res.status(400).json({
                error: 'Missing required fields'
            });
        }

        const candidateResult = await db.query(
            `INSERT INTO request_collector_candidates (request_id, collector_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM requests WHERE id = $1 AND status IN ('pending', 'CREATED'))
             ON CONFLICT (request_id, collector_id) DO NOTHING
             RETURNING *`,
            [request_id, collector_id]
        );
        if (!candidateResult.rows.length) {
            return res.status(409).json({ error: 'You have already selected this request or it does not exist' });
        }

        res.json({ success: true, candidate: candidateResult.rows[0], message: 'Your request to collect was sent to the user' });
        return;

        /* The old direct assignment flow is intentionally kept below as a reference. */
        let query;
        let values;

        if (collector_location) {
            const cleanLocation = collector_location
                .toString()
                .replace(/[()]/g, '')
                .trim();

            const [lat, lng] = cleanLocation
                .split(',')
                .map(v => v.trim());

            if (
                lat === undefined ||
                lng === undefined ||
                isNaN(parseFloat(lat)) ||
                isNaN(parseFloat(lng))
            ) {
                return res.status(400).json({
                    error: 'Invalid collector location'
                });
            }

            query = `
                UPDATE requests
                SET
                    status = $1,
                    collector_id = $2,
                    collector_gps = POINT($4, $3),
                    collected_at = CURRENT_TIMESTAMP
                WHERE id = $5
                RETURNING *
            `;

            values = [
                'assigned',
                collector_id,
                parseFloat(lat),
                parseFloat(lng),
                request_id
            ];

        } else {
            query = `
                UPDATE requests
                SET
                    status = $1,
                    collector_id = $2,
                    collected_at = CURRENT_TIMESTAMP
                WHERE id = $3
                RETURNING *
            `;

            values = [
                'assigned',
                collector_id,
                request_id
            ];
        }

        console.log('Collect request query:', query);
        console.log('Collect request values:', values);

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Request not found'
            });
        }

        res.json({
            success: true,
            request: result.rows[0]
        });

    } catch (error) {
        console.error('Error collecting request:', error);

        res.status(500).json({
            error: 'Failed to collect request',
            details: error.message
        });
    }
});

app.put('/api/requests/select-collector', async (req, res) => {
    try {
        const { request_id, user_id, collector_id } = req.body;
        if (!request_id || !user_id || !collector_id) return res.status(400).json({ error: 'Missing required fields' });

        const result = await db.query(
            `UPDATE requests r
             SET status = 'in_progress', collector_id = $1, collected_at = CURRENT_TIMESTAMP
             WHERE r.id = $2 AND r.user_id = $3 AND r.status IN ('pending', 'CREATED')
               AND EXISTS (SELECT 1 FROM request_collector_candidates c WHERE c.request_id = r.id AND c.collector_id = $1)
             RETURNING r.*`,
            [collector_id, request_id, user_id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Collector selection is no longer available' });
        const selected = await db.query(
            `SELECT r.*, c.name AS collector_name, c.phone AS collector_phone,
                    c.profile_image AS collector_profile_image
             FROM requests r LEFT JOIN collectors c ON c.id = r.collector_id
             WHERE r.id = $1`,
            [request_id]
        );
        res.json({ success: true, request: selected.rows[0] });
    } catch (error) {
        console.error('Error selecting collector:', error);
        res.status(500).json({ error: 'Failed to select collector' });
    }
});

// Secure workflow API. The legacy endpoints above remain for migration compatibility.
app.get('/api/v2/collector/dashboard', authenticate, authorize('collector'), async (req, res) => {
    try {
        const result = await db.query(`SELECT
            COUNT(*) FILTER (WHERE status IN ('ASSIGNED', 'assigned'))::int AS assigned_requests,
            COUNT(*) FILTER (WHERE status IN ('COLLECTOR_EN_ROUTE', 'in_progress'))::int AS in_progress,
            COUNT(*) FILTER (WHERE status IN ('AWAITING_USER_CONFIRMATION', 'completion_pending'))::int AS pending_confirmation,
            COUNT(*) FILTER (WHERE status IN ('COMPLETED', 'completed') AND completed_at::date = CURRENT_DATE)::int AS completed_today,
            COUNT(*) FILTER (WHERE status IN ('DISPUTED', 'disputed'))::int AS disputed_requests
            FROM requests WHERE collector_id = $1`, [req.auth.sub]);
        const materialTotals = await db.query(`SELECT material_type,
                SUM(COALESCE(actual_weight, collected_weight, 0))::numeric(12, 3) AS total_weight_kg
            FROM requests
            WHERE collector_id = $1 AND status IN ('COMPLETED', 'completed')
            GROUP BY material_type
            ORDER BY material_type`, [req.auth.sub]);
        res.json({ dashboard: { ...result.rows[0], material_totals: materialTotals.rows } });
    } catch (error) { console.error('Collector dashboard failed:', error); res.status(500).json({ error: 'Failed to load collector dashboard' }); }
});

app.get('/api/v2/collector/requests', authenticate, authorize('collector'), async (req, res) => {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = (page - 1) * limit;
    const allowedStatuses = ['CREATED', 'ASSIGNED', 'COLLECTOR_EN_ROUTE', 'ARRIVED', 'WEIGHING', 'AWAITING_USER_CONFIRMATION', 'DISPUTED', 'COMPLETED', 'CANCELLED', 'FAILED', 'assigned', 'in_progress', 'completion_pending', 'completed'];
    const values = [req.auth.sub, limit, offset];
    const conditions = ["(r.collector_id = $1 OR (r.collector_id IS NULL AND r.status IN ('CREATED', 'pending'))) "];
    if (req.query.status && allowedStatuses.includes(req.query.status)) { values.push(req.query.status); conditions.push(`r.status = $${values.length}`); }
    if (req.query.material) { values.push(String(req.query.material).slice(0, 80)); conditions.push(`r.material_type = $${values.length}`); }
    try {
        const result = await db.query(`SELECT r.id, r.public_reference, r.collector_id, r.material_type, r.weight AS estimated_weight,
                COALESCE(r.actual_weight, r.collected_weight) AS actual_weight, r.location, r.gps,
                r.status, r.preferred_pickup_at, r.created_at, u.name AS user_name, u.phone AS user_phone,
                CASE WHEN r.collector_id = $1 THEN 'assigned' ELSE 'available' END AS request_scope,
                EXISTS (SELECT 1 FROM request_collector_candidates candidate
                    WHERE candidate.request_id = r.id AND candidate.collector_id = $1) AS has_requested
            FROM requests r JOIN users u ON u.id = r.user_id
            WHERE ${conditions.join(' AND ')} ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, values);
        const countValues = [req.auth.sub];
        const countConditions = ["(r.collector_id = $1 OR (r.collector_id IS NULL AND r.status IN ('CREATED', 'pending'))) "];
        if (req.query.status && allowedStatuses.includes(req.query.status)) { countValues.push(req.query.status); countConditions.push(`r.status = $${countValues.length}`); }
        if (req.query.material) { countValues.push(String(req.query.material).slice(0, 80)); countConditions.push(`r.material_type = $${countValues.length}`); }
        const count = await db.query(`SELECT COUNT(*)::int AS total FROM requests r WHERE ${countConditions.join(' AND ')}`, countValues);
        res.json({ requests: result.rows, pagination: { page, limit, total: count.rows[0].total } });
    } catch (error) { console.error('Collector requests failed:', error); res.status(500).json({ error: 'Failed to load assigned requests' }); }
});

app.get('/api/v2/collector/requests/:id', authenticate, authorize('collector'), async (req, res) => {
    try {
        const result = await db.query(`SELECT r.id, r.public_reference, r.material_type, r.weight AS estimated_weight,
                COALESCE(r.actual_weight, r.collected_weight) AS actual_weight, r.location, r.gps, r.description,
                r.status, r.preferred_pickup_at, r.created_at, r.collected_at, r.completed_at,
                u.name AS user_name, u.phone AS user_phone
            FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1 AND r.collector_id = $2`, [req.params.id, req.auth.sub]);
        if (!result.rows.length) return res.status(404).json({ code: 'REQUEST_NOT_FOUND', error: 'Request not found' });
        res.json({ request: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to load request details' }); }
});

app.get('/api/v2/collector/notifications', authenticate, authorize('collector'), async (req, res) => {
    try {
        const result = await db.query(`SELECT id, event_type, entity_type, entity_id, payload, read_at, created_at
            FROM notifications WHERE recipient_id = $1 AND recipient_role = 'collector' ORDER BY created_at DESC LIMIT 50`, [req.auth.sub]);
        res.json({ notifications: result.rows });
    } catch (error) { res.status(500).json({ error: 'Failed to load notifications' }); }
});

app.post('/api/v2/collector/requests/:id/accept', authenticate, authorize('collector'), async (req, res) => {
    try {
        const result = await db.query(`UPDATE requests SET status = 'ASSIGNED' WHERE id = $1 AND collector_id = $2 AND status IN ('CREATED', 'pending') RETURNING *`, [req.params.id, req.auth.sub]);
        if (!result.rows.length) return res.status(409).json({ code: 'INVALID_ASSIGNMENT', error: 'Request is not assigned to this collector or is no longer available' });
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'REQUEST_ACCEPTED', entityType: 'request', entityId: req.params.id, newValue: { status: 'ASSIGNED' } });
        res.json({ request: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to accept request' }); }
});

app.post('/api/v2/collector/requests/:id/no-show', authenticate, authorize('collector'), async (req, res) => {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(422).json({ code: 'REASON_REQUIRED', error: 'A reason is required' });
    try {
        const result = await db.query(`UPDATE requests SET status = 'USER_NO_SHOW' WHERE id = $1 AND collector_id = $2 AND status IN ('COLLECTOR_EN_ROUTE', 'ARRIVED') RETURNING *`, [req.params.id, req.auth.sub]);
        if (!result.rows.length) return res.status(409).json({ code: 'INVALID_STATE', error: 'No-show can only be reported during an active pickup' });
        await db.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role, reason) VALUES ($1, 'ARRIVED', 'USER_NO_SHOW', $2, 'collector', $3)", [req.params.id, req.auth.sub, reason]);
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'NO_SHOW_REPORTED', entityType: 'request', entityId: req.params.id, newValue: { status: 'USER_NO_SHOW' }, metadata: { reason } });
        res.json({ request: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to report user no-show' }); }
});

app.post('/api/v2/collector/requests/:id/cancellation-request', authenticate, authorize('collector'), async (req, res) => {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(422).json({ code: 'REASON_REQUIRED', error: 'A reason is required' });
    try {
        const result = await db.query(`SELECT id, status FROM requests WHERE id = $1 AND collector_id = $2`, [req.params.id, req.auth.sub]);
        if (!result.rows.length) return res.status(404).json({ code: 'REQUEST_NOT_FOUND', error: 'Request not found' });
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'CANCELLATION_REQUESTED', entityType: 'request', entityId: req.params.id, metadata: { reason, status: result.rows[0].status } });
        res.status(202).json({ message: 'Cancellation request submitted for review' });
    } catch (error) { res.status(500).json({ error: 'Failed to submit cancellation request' }); }
});

app.post('/api/v2/requests', authenticate, authorize('user'), async (req, res) => {
    const { material_type, estimated_weight, location, gps, preferred_pickup_at, description } = req.body;
    const weight = Number(estimated_weight);
    const gpsValues = String(gps || '').split(',').map(value => Number(value.trim()));
    if (!material_type || !location || !Number.isFinite(weight) || weight <= 0 || gpsValues.length !== 2 || gpsValues.some(value => !Number.isFinite(value))) {
        return res.status(400).json({ error: 'Material, pickup location, valid pickup GPS, and a positive estimated weight are required' });
    }
            try {
        const result = await db.query(
            `INSERT INTO requests (user_id, material_type, weight, location, description, gps, preferred_pickup_at, status, public_reference)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE POINT(split_part($6::text, ',', 2)::double precision, split_part($6::text, ',', 1)::double precision) END, $7, 'CREATED', 'REQ-' || upper(substr(md5(random()::text), 1, 10)))
             RETURNING id, public_reference, material_type, weight AS estimated_weight, location, gps, preferred_pickup_at, status, created_at`,
            [req.auth.sub, material_type, weight, location, description || null, gps || null, preferred_pickup_at || null]
        );
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'REQUEST_CREATED', entityType: 'request', entityId: result.rows[0].id, newValue: result.rows[0] });
        res.status(201).json({ request: result.rows[0] });
    } catch (error) {
        console.error('v2 request creation failed:', error);
        res.status(500).json({ error: 'Failed to create collection request' });
    }
});

app.post('/api/v2/requests/:id/trip/start', authenticate, authorize('collector'), async (req, res) => {
    const { latitude, longitude } = req.body;
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return res.status(400).json({ error: 'Valid GPS coordinates are required' });
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const collector = await client.query("SELECT account_status, availability_status FROM collectors WHERE id = $1 FOR UPDATE", [req.auth.sub]);
        const current = await client.query('SELECT * FROM requests WHERE id = $1 AND collector_id = $2 FOR UPDATE', [req.params.id, req.auth.sub]);
        if (!collector.rows.length || !['active', 'pending'].includes(collector.rows[0].account_status)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Collector account is not approved for operations' });
        }
        if (!current.rows.length || !["ASSIGNED", "in_progress"].includes(current.rows[0].status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Request is not ready for a trip' });
        }
        const updated = await client.query("UPDATE requests SET status = 'COLLECTOR_EN_ROUTE', collected_at = COALESCE(collected_at, CURRENT_TIMESTAMP) WHERE id = $1 AND collector_id = $2 RETURNING *", [req.params.id, req.auth.sub]);
        await client.query("UPDATE collectors SET availability_status = 'on_trip' WHERE id = $1", [req.auth.sub]);
        await client.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role) VALUES ($1, $2, 'COLLECTOR_EN_ROUTE', $3, 'collector')", [req.params.id, current.rows[0].status, req.auth.sub]);
        await client.query(`INSERT INTO pickup_events (request_id, collector_id, event_type, latitude, longitude) VALUES ($1, $2, 'TRIP_STARTED', $3, $4)`, [req.params.id, req.auth.sub, latitude, longitude]);
        await enqueueNotification(client, { recipientId: current.rows[0].user_id, recipientRole: 'user', eventType: 'TRIP_STARTED', entityType: 'request', entityId: req.params.id, payload: { message: 'Your Collector is on the way.' } });
        await audit(client, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'TRIP_STARTED', entityType: 'request', entityId: req.params.id, newValue: { latitude, longitude } });
        await client.query('COMMIT');
        res.json({ request: updated.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Trip start failed:', error);
        res.status(500).json({ error: 'Failed to start trip' });
    } finally { client.release(); }
});

app.post('/api/v2/requests/:id/arrival', authenticate, authorize('collector'), async (req, res) => {
    const { latitude, longitude, accuracy } = req.body;
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return res.status(400).json({ error: 'Valid GPS coordinates are required' });
    const toleranceResult = await db.query("SELECT rule_value FROM platform_rules WHERE rule_key = 'arrival_tolerance_meters'");
    const tolerance = Number(toleranceResult.rows[0]?.rule_value || 150);
    try {
        const requestResult = await db.query(`SELECT id, user_id, gps, status FROM requests WHERE id = $1 AND collector_id = $2`, [req.params.id, req.auth.sub]);
        if (!requestResult.rows.length) return res.status(404).json({ error: 'Assigned request not found' });
        const pickup = requestResult.rows[0].gps;
        const pickupPosition = typeof pickup === 'object' ? [Number(pickup.y), Number(pickup.x)] : String(pickup || '').replace(/[()]/g, '').split(',').map(Number).reverse();
        if (pickupPosition.length !== 2 || pickupPosition.some(value => !Number.isFinite(value))) return res.status(422).json({ code: 'PICKUP_LOCATION_MISSING', error: 'Pickup coordinates are unavailable for this request' });
        const verification = verifyArrival({ collectorPosition: [Number(latitude), Number(longitude)], pickupPosition, toleranceMeters: tolerance });
        const verified = verification.valid;
        const event = await db.query(`INSERT INTO pickup_events (request_id, collector_id, event_type, latitude, longitude, distance_meters, verified) VALUES ($1, $2, 'ARRIVAL', $3, $4, $5, $6) RETURNING *`, [req.params.id, req.auth.sub, latitude, longitude, verification.distanceMeters, verified]);
        await db.query(`INSERT INTO arrival_verifications
            (request_id, collector_id, user_latitude, user_longitude, collector_latitude, collector_longitude, distance_meters, allowed_radius_meters, accuracy_meters, verified, rejection_reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [req.params.id, req.auth.sub, pickupPosition[0], pickupPosition[1], latitude, longitude,
                verification.distanceMeters, tolerance, accuracy, verified,
                verified ? null : 'OUTSIDE_ALLOWED_RADIUS']);
        if (!verified) return res.status(422).json({
            error: 'Collector is outside the configured arrival radius',
            code: 'ARRIVAL_OUTSIDE_RADIUS',
            distance_meters: verification.distanceMeters,
            tolerance_meters: tolerance,
            event: event.rows[0]
        });
        const updated = await db.query("UPDATE requests SET status = 'ARRIVED' WHERE id = $1 AND status = 'COLLECTOR_EN_ROUTE' RETURNING *", [req.params.id]);
        if (!updated.rows.length) return res.status(409).json({ error: 'Invalid request status transition' });
        await db.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role) VALUES ($1, 'COLLECTOR_EN_ROUTE', 'ARRIVED', $2, 'collector')", [req.params.id, req.auth.sub]);
        await enqueueNotification(db, { recipientId: requestResult.rows[0].user_id, recipientRole: 'user', eventType: 'ARRIVAL_VERIFIED', entityType: 'request', entityId: req.params.id, payload: { message: 'Your Collector has arrived.' } });
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'ARRIVAL_VERIFIED', entityType: 'request', entityId: req.params.id, newValue: verification });
        res.json({ request: updated.rows[0], verification });
    } catch (error) {
        console.error('Arrival verification failed:', error);
        res.status(500).json({ error: 'Failed to verify arrival' });
    }
});

app.post('/api/v2/requests/:id/weight', authenticate, authorize('collector'), async (req, res) => {
    const actualWeight = Number(req.body.actual_weight);
    if (!Number.isFinite(actualWeight) || actualWeight <= 0) return res.status(400).json({ error: 'A positive actual weight is required' });
    const { latitude, longitude, accuracy } = req.body;
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return res.status(400).json({ error: 'Valid collector GPS coordinates are required' });
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE requests SET actual_weight = $1, collected_weight = $1, status = 'AWAITING_USER_CONFIRMATION' WHERE id = $2 AND collector_id = $3 AND status = 'ARRIVED' AND actual_weight IS NULL AND EXISTS (SELECT 1 FROM arrival_verifications verification WHERE verification.request_id = requests.id AND verification.collector_id = $3 AND verification.verified = TRUE) RETURNING *`, [actualWeight, req.params.id, req.auth.sub]);
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Weight can only be recorded once after verified arrival' });
        }        
        await client.query(`INSERT INTO weight_records (request_id, user_id, collector_id, estimated_weight_snapshot, actual_weight, unit, latitude, longitude, gps_accuracy)
            VALUES ($1, $2, $3, $4, $5, 'kg', $6, $7, $8)`, [req.params.id, result.rows[0].user_id, req.auth.sub, result.rows[0].weight, actualWeight, latitude, longitude, accuracy ?? null]);
        await client.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role) VALUES ($1, 'ARRIVED', 'AWAITING_USER_CONFIRMATION', $2, 'collector')", [req.params.id, req.auth.sub]);
        await enqueueNotification(client, { recipientId: result.rows[0].user_id, recipientRole: 'user', eventType: 'WEIGHT_SUBMITTED', entityType: 'request', entityId: req.params.id, payload: { actual_weight: actualWeight, message: 'Your material was weighed. Please confirm the weight.' } });
        await audit(client, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'ACTUAL_WEIGHT_RECORDED', entityType: 'request', entityId: req.params.id, newValue: { actual_weight: actualWeight } });
        await client.query('COMMIT');
        res.json({ request: result.rows[0] });
    } catch (error) { await client.query('ROLLBACK'); console.error('Weight record failed:', error); res.status(500).json({ error: 'Failed to record actual weight' }); }
    finally { client.release(); }
});

app.post('/api/v2/requests/:id/weight-confirmation', authenticate, authorize('user'), async (req, res) => {
    const { action, reason } = req.body;
    if (!['confirm', 'dispute'].includes(action)) return res.status(400).json({ error: 'Action must be confirm or dispute' });
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query('SELECT * FROM requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, req.auth.sub]);
        const confirmationStatuses = ['AWAITING_USER_CONFIRMATION', 'completion_pending', 'waiting_user_weight_confirmation'];
        if (!current.rows.length || !confirmationStatuses.includes(current.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Weight is not awaiting confirmation' }); }
        const request = current.rows[0];
        const actualWeight = Number(request.actual_weight ?? request.collected_weight);
        if (!Number.isFinite(actualWeight) || actualWeight <= 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'The collector has not submitted a valid actual weight' });
        }
        if (action === 'dispute') {
            const updated = await client.query("UPDATE requests SET status = 'DISPUTED', disputed_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *", [req.params.id]);
            await client.query('INSERT INTO disputes (request_id, opened_by, reason, original_value) VALUES ($1, $2, $3, $4)', [req.params.id, req.auth.sub, reason || 'User disputed recorded weight', JSON.stringify({ actual_weight: actualWeight })]);
            await audit(client, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'WEIGHT_DISPUTED', entityType: 'request', entityId: req.params.id, previousValue: { status: request.status, actual_weight: request.actual_weight }, newValue: { status: 'DISPUTED' }, metadata: { reason } });
            await client.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role) VALUES ($1, $2, 'DISPUTED', $3, 'user')", [req.params.id, request.status, req.auth.sub]);
            await client.query('COMMIT');
            return res.json({ request: updated.rows[0] });
        }
        const material = await client.query('SELECT points_per_kg, rounding FROM material_types WHERE lower(trim(code)) = lower(trim($1)) AND active = TRUE', [request.material_type]);
        if (!material.rows.length) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: `No active points rule exists for material "${request.material_type}". Apply the backend migration and activate its points rule before confirming.` });
        }
        const points = calculatePoints({ actualWeight, pointsPerKg: material.rows[0].points_per_kg, rounding: material.rows[0].rounding });
        const updated = await client.query("UPDATE requests SET status = 'COMPLETED', actual_weight = $4, completed_at = CURRENT_TIMESTAMP, weight_confirmed_at = CURRENT_TIMESTAMP, weight_confirmed_by = $1, points_awarded = $2 WHERE id = $3 AND status IN ('AWAITING_USER_CONFIRMATION', 'completion_pending', 'waiting_user_weight_confirmation') RETURNING *", [req.auth.sub, points, req.params.id, actualWeight]);
        await client.query('INSERT INTO point_ledger (user_id, request_id, points, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [req.auth.sub, req.params.id, points, 'verified_collection']);
        await client.query('UPDATE users SET points = COALESCE(points, 0) + $1 WHERE id = $2', [points, req.auth.sub]);
        await client.query(`INSERT INTO material_batches (public_reference, request_id, material_type, collection_weight, status)
            VALUES ('BAT-' || upper(substr(md5(random()::text), 1, 10)), $1, $2, $3, 'created') ON CONFLICT (request_id) DO NOTHING`, [req.params.id, request.material_type, actualWeight]);
        await client.query("INSERT INTO request_status_history (request_id, old_status, new_status, changed_by_user_id, changed_by_role) VALUES ($1, $2, 'COMPLETED', $3, 'user')", [req.params.id, request.status, req.auth.sub]);
        await audit(client, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'WEIGHT_CONFIRMED_AND_POINTS_CALCULATED', entityType: 'request', entityId: req.params.id, previousValue: { status: request.status }, newValue: { status: 'COMPLETED', points, final_weight: actualWeight } });
        const user = await client.query('SELECT id, name, email, points FROM users WHERE id = $1', [req.auth.sub]);
        await client.query('COMMIT');
        res.json({ request: updated.rows[0], points_added: points, user: user.rows[0] });
    } catch (error) { await client.query('ROLLBACK'); console.error('Weight confirmation failed:', error); res.status(500).json({ error: 'Failed to process weight confirmation' }); }
    finally { client.release(); }
});

app.post('/api/v2/batches/:id/receive', authenticate, authorize('recycler'), async (req, res) => {
    const receivingWeight = Number(req.body.receiving_weight);
    if (!Number.isFinite(receivingWeight) || receivingWeight <= 0) return res.status(400).json({ error: 'A positive receiving weight is required' });
    try {
        const batchResult = await db.query('SELECT b.*, mt.allowed_variance_percent FROM material_batches b LEFT JOIN material_types mt ON mt.code = b.material_type WHERE b.id = $1 FOR UPDATE', [req.params.id]);
        if (!batchResult.rows.length) return res.status(404).json({ error: 'Material batch not found' });
        const batch = batchResult.rows[0];
        if (batch.status === 'received') return res.status(409).json({ error: 'Batch has already been received' });
        const reconciliation = reconcileWeights({ collectionWeight: batch.collection_weight, receivingWeight, allowedVariancePercent: batch.allowed_variance_percent ?? 5 });
        const updated = await db.query(`UPDATE material_batches SET receiving_weight = $1, recycler_id = $2, status = 'received', received_at = CURRENT_TIMESTAMP, variance_flagged = $3 WHERE id = $4 RETURNING *`, [receivingWeight, req.auth.sub, reconciliation.flagged, req.params.id]);
        await db.query("UPDATE requests SET status = 'RECEIVED_BY_RECYCLER' WHERE id = $1 AND status IN ('CONFIRMED', 'COMPLETED', 'SENT_TO_RECYCLER')", [batch.request_id]);
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'RECYCLER_RECEIPT_RECORDED', entityType: 'material_batch', entityId: req.params.id, newValue: { receivingWeight, reconciliation } });
        res.json({ batch: updated.rows[0], reconciliation });
    } catch (error) { console.error('Batch receipt failed:', error); res.status(500).json({ error: 'Failed to record recycling receipt' }); }
});
app.get('/api/v2/recycler/batches', authenticate, authorize('recycler'), async (req, res) => {
    try {
        const result = await db.query(`SELECT b.id, b.public_reference, b.material_type, b.collection_weight,
                b.receiving_weight, b.status, b.variance_flagged, b.created_at, b.received_at
            FROM material_batches b WHERE b.status <> 'received' OR b.recycler_id = $1
            ORDER BY b.created_at DESC LIMIT 50`, [req.auth.sub]);
        res.json({ batches: result.rows });
    } catch (error) { res.status(500).json({ error: 'Failed to load material batches' }); }
});

app.get('/api/v2/admin/overview', authenticate, authorize('admin'), async (req, res) => {
    try {
        const result = await db.query(`SELECT
            (SELECT COUNT(*) FROM users WHERE account_status = 'active')::int AS users,
            (SELECT COUNT(*) FROM collectors WHERE account_status = 'active')::int AS active_collectors,
            (SELECT COUNT(*) FROM recycling_partners WHERE account_status = 'active')::int AS recycling_partners,
            (SELECT COUNT(*) FROM requests WHERE status IN ('CREATED', 'pending'))::int AS pending_requests,
            (SELECT COUNT(*) FROM requests WHERE status IN ('COMPLETED', 'completed'))::int AS completed_collections,
            (SELECT COUNT(*) FROM disputes WHERE status = 'open')::int AS open_disputes,
            (SELECT COUNT(*) FROM material_batches WHERE variance_flagged = TRUE)::int AS flagged_batches`);
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'ADMIN_OVERVIEW_VIEWED', entityType: 'platform', entityId: 'overview' });
        res.json({ overview: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to load admin overview' }); }
});

app.get('/api/v2/admin/reports', authenticate, authorize('admin'), async (req, res) => {
    try {
        const result = await db.query(`SELECT id, user_id, problem_type, address, description,
                latitude, longitude, ai_contains_trash, ai_confidence, ai_reason,
                captured_at, capture_accuracy_m, capture_method, status, created_at
            FROM reports
            ORDER BY created_at DESC, id DESC
            LIMIT 100`);
        await audit(db, {
            actorId: req.auth.sub,
            actorRole: req.auth.role,
            action: 'ADMIN_REPORTS_VIEWED',
            entityType: 'reports',
            entityId: 'latest'
        });
        res.json({ reports: result.rows });
    } catch (error) {
        console.error('Admin environmental reports load failed:', error);
        res.status(500).json({ error: 'Failed to load environmental reports' });
    }
});

app.get('/api/v2/admin/reports/:id/image', authenticate, authorize('admin'), async (req, res) => {
    const reportId = Number(req.params.id);
    if (!Number.isSafeInteger(reportId) || reportId < 1) {
        return res.status(400).json({ error: 'Invalid report ID' });
    }

    try {
        const result = await db.query('SELECT image FROM reports WHERE id = $1', [reportId]);
        const filename = result.rows[0]?.image;
        if (!filename || path.basename(filename) !== filename) {
            return res.status(404).json({ error: 'No saved image was found for this report' });
        }

        const extension = path.extname(filename).toLowerCase();
        const mimeType = Object.entries(REPORT_IMAGE_EXTENSIONS)
            .find(([, allowedExtension]) => allowedExtension === extension)?.[0];
        if (!mimeType) {
            return res.status(404).json({ error: 'No saved image was found for this report' });
        }

        const image = await fs.promises.readFile(path.join(REPORT_IMAGE_DIR, filename));
        res.set('Cache-Control', 'private, no-store');
        res.type(mimeType);
        res.send(image);
    } catch (error) {
        console.error('Admin report image load failed:', {
            reportId,
            message: error.message,
            code: error.code
        });
        res.status(500).json({ error: 'Failed to load the report image' });
    }
});

app.patch('/api/v2/admin/collectors/:id/status', authenticate, authorize('admin'), async (req, res) => {
    const allowedStatuses = ['pending', 'active', 'suspended', 'inactive'];
    if (!allowedStatuses.includes(req.body.status)) return res.status(422).json({ error: 'Invalid collector account status' });
    try {
        const result = await db.query('UPDATE collectors SET account_status = $1 WHERE id = $2 RETURNING id, name, account_status, availability_status', [req.body.status, req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Collector not found' });
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'COLLECTOR_STATUS_CHANGED', entityType: 'collector', entityId: req.params.id, newValue: result.rows[0] });
        res.json({ collector: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to update collector status' }); }
});

app.post('/api/v2/admin/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    try {
        const result = await db.query(
            'SELECT id, name, email, password_hash, active FROM admins WHERE email = $1',
            [email]
        );
        if (!result.rows.length || !result.rows[0].active ||
            !(await bcrypt.compare(password, result.rows[0].password_hash))) {
            return res.status(401).json({ error: 'Invalid admin credentials' });
        }
        const admin = result.rows[0];
        res.json({
            admin: { id: admin.id, name: admin.name, email: admin.email },
            token: signToken(admin, 'admin')
        });
    } catch (error) {
        console.error('Admin login failed:', error);
        res.status(500).json({ error: 'Admin login failed' });
    }
});

app.get('/api/v2/admin/sellers', authenticate, authorize('admin'), async (req, res) => {
    try {
        const result = await db.query(`SELECT id, name, legal_name, email, phone,
                commercial_registration_number, tax_registration_number, business_activity,
                business_address, branch_name, branch_address, responsible_person,
                account_status, rejection_reason, verified_at, verified_by, created_at
            FROM sellers ORDER BY created_at DESC`);
        res.json({ sellers: result.rows });
    } catch (error) { res.status(500).json({ error: 'Failed to load seller registrations' }); }
});

app.patch('/api/v2/admin/sellers/:id/status', authenticate, authorize('admin'), async (req, res) => {
    const statusMap = { approve: 'VERIFIED', verify: 'VERIFIED', reject: 'REJECTED', suspend: 'SUSPENDED' };
    const status = statusMap[String(req.body.status || '').toLowerCase()];
    if (!status) return res.status(422).json({ error: 'Status must be approve, reject, or suspend' });
    try {
        const result = await db.query(`UPDATE sellers SET account_status = $1,
                verified_at = CASE WHEN $1 = 'VERIFIED' THEN CURRENT_TIMESTAMP ELSE verified_at END,
                verified_by = CASE WHEN $1 = 'VERIFIED' THEN $2 ELSE verified_by END,
                rejection_reason = CASE WHEN $1 = 'REJECTED' THEN $3 ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP WHERE id = $4
            RETURNING id, name, email, account_status, rejection_reason, verified_at, verified_by`,
            [status, req.auth.sub, req.body.rejection_reason || null, req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Seller not found' });
        await audit(db, { actorId: req.auth.sub, actorRole: req.auth.role, action: 'SELLER_STATUS_CHANGED', entityType: 'seller', entityId: req.params.id, newValue: result.rows[0] });
        res.json({ seller: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to update seller status' }); }
});

app.get('/api/v2/user/discount-coupon', authenticate, authorize('user'), async (req, res) => {
    try {
        const result = await db.query(`SELECT c.code, c.status, c.discount_percent,
                c.points_deducted, c.created_at, c.redeemed_at,
                COALESCE(u.points, 0) AS points
            FROM users u
            LEFT JOIN LATERAL (
                SELECT code, status, discount_percent, points_deducted, created_at, redeemed_at
                FROM discount_coupons
                WHERE user_id = u.id
                ORDER BY (status = 'active') DESC, created_at DESC
                LIMIT 1
            ) c ON TRUE
            WHERE u.id = $1`, [req.auth.sub]);
        if (!result.rows.length) return res.status(404).json({ error: 'User account not found' });
        const { points, ...couponFields } = result.rows[0];
        const coupon = couponFields.code ? couponFields : null;
        res.json({ coupon, points: Number(points) });
    } catch (error) {
        console.error('User discount coupon load failed:', error);
        res.status(500).json({ error: 'Failed to load discount coupon' });
    }
});

app.post('/api/v2/user/discount-coupon', authenticate, authorize('user'), async (req, res) => {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query(`SELECT COALESCE(points, 0) AS points
            FROM users WHERE id = $1 FOR UPDATE`, [req.auth.sub]);
        if (!userResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User account not found' });
        }
        const points = Number(userResult.rows[0].points);
        if (points <= 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'You need points to create a discount coupon' });
        }

        const activeCoupon = await client.query(`SELECT code, status, discount_percent,
                points_deducted, created_at, redeemed_at
            FROM discount_coupons WHERE user_id = $1 AND status = 'active'`,
        [req.auth.sub]);
        if (activeCoupon.rows.length) {
            await client.query('COMMIT');
            return res.json({ coupon: activeCoupon.rows[0], points });
        }

        let coupon;
        for (let attempt = 0; attempt < 5 && !coupon; attempt += 1) {
            const code = `GN${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
            const inserted = await client.query(`INSERT INTO discount_coupons (code, user_id)
                VALUES ($1, $2) ON CONFLICT (code) DO NOTHING
                RETURNING code, status, discount_percent, points_deducted, created_at, redeemed_at`,
            [code, req.auth.sub]);
            coupon = inserted.rows[0];
        }
        if (!coupon) throw new Error('Could not generate a unique discount coupon');

        await client.query('COMMIT');
        res.status(201).json({ coupon, points });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('User discount coupon creation failed:', error);
        res.status(500).json({ error: 'Failed to create discount coupon' });
    } finally {
        client.release();
    }
});

app.get('/api/v2/seller/discount-coupons/:code', authenticate, authorize('merchant'), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^GN[A-F0-9]{12}$/.test(code)) {
        return res.status(422).json({ error: 'Enter a valid Greenovation coupon code' });
    }
    try {
        const seller = await db.query('SELECT account_status FROM sellers WHERE id = $1', [req.auth.sub]);
        if (!seller.rows.length || seller.rows[0].account_status !== 'VERIFIED') {
            return res.status(403).json({ error: 'Seller verification is required to redeem coupons' });
        }
        const result = await db.query(`SELECT c.code, c.status, c.discount_percent, c.points_deducted,
                c.created_at, c.redeemed_at, u.id AS user_id, u.name AS user_name,
                u.email AS user_email, COALESCE(u.points, 0) AS points
            FROM discount_coupons c
            JOIN users u ON u.id = c.user_id
            WHERE c.code = $1`, [code]);
        if (!result.rows.length) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ coupon: result.rows[0] });
    } catch (error) {
        console.error('Seller discount coupon lookup failed:', error);
        res.status(500).json({ error: 'Failed to look up discount coupon' });
    }
});

app.post('/api/v2/seller/discount-coupons/:code/redeem', authenticate, authorize('merchant'), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^GN[A-F0-9]{12}$/.test(code)) {
        return res.status(422).json({ error: 'Enter a valid Greenovation coupon code' });
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const sellerResult = await client.query('SELECT account_status FROM sellers WHERE id = $1 FOR SHARE', [req.auth.sub]);
        if (!sellerResult.rows.length || sellerResult.rows[0].account_status !== 'VERIFIED') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Seller verification is required to redeem coupons' });
        }
        const couponResult = await client.query(`SELECT code, user_id, status, discount_percent
            FROM discount_coupons WHERE code = $1 FOR UPDATE`, [code]);
        if (!couponResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Coupon not found' });
        }
        const coupon = couponResult.rows[0];
        if (coupon.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This coupon has already been redeemed' });
        }
        const userResult = await client.query(`SELECT id, name, email, COALESCE(points, 0) AS points
            FROM users WHERE id = $1 FOR UPDATE`, [coupon.user_id]);
        if (!userResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Coupon owner account not found' });
        }
        const user = userResult.rows[0];
        const pointsDeducted = Number(user.points);
        if (pointsDeducted <= 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'The customer has no points to redeem this coupon' });
        }

        const updatedUser = await client.query(`UPDATE users SET points = 0
            WHERE id = $1 RETURNING COALESCE(points, 0) AS points`, [user.id]);
        await client.query(`INSERT INTO point_ledger (user_id, request_id, points, reason)
            VALUES ($1, NULL, $2, 'discount_coupon_redemption')`, [user.id, -pointsDeducted]);
        const updatedCoupon = await client.query(`UPDATE discount_coupons
            SET status = 'redeemed', points_deducted = $1, redeemed_at = CURRENT_TIMESTAMP, redeemed_by = $2
            WHERE code = $3
            RETURNING code, status, discount_percent, points_deducted, created_at, redeemed_at`,
        [pointsDeducted, req.auth.sub, code]);
        await audit(client, {
            actorId: req.auth.sub,
            actorRole: 'merchant',
            action: 'DISCOUNT_COUPON_REDEEMED',
            entityType: 'discount_coupon',
            entityId: code,
            previousValue: { userId: user.id, points: pointsDeducted, status: 'active' },
            newValue: { userId: user.id, points: Number(updatedUser.rows[0].points), status: 'redeemed', discountPercent: 20 }
        });
        await client.query('COMMIT');
        res.json({
            coupon: {
                ...updatedCoupon.rows[0],
                user_id: user.id,
                user_name: user.name,
                user_email: user.email,
                points: Number(updatedUser.rows[0].points)
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Seller discount coupon redemption failed:', error);
        res.status(500).json({ error: 'Failed to redeem discount coupon' });
    } finally {
        client.release();
    }
});

app.put('/api/requests/complete', async (req, res) => {
    return res.status(410).json({ error: 'This workflow is retired. Use the verified v2 weight endpoint.' });
    try {
        const { request_id, collector_id, collected_weight } = req.body;
        const actualWeight = Number(collected_weight);
        
        if (!request_id || !collector_id || !Number.isFinite(actualWeight) || actualWeight <= 0) {
            return res.status(400).json({ error: 'A valid collected quantity is required' });
        }
        
        const result = await db.query(
            'UPDATE requests SET status = $1, collected_weight = $2, actual_weight = $2 WHERE id = $3 AND collector_id = $4 AND status IN ($5, $6) AND actual_weight IS NULL RETURNING *',
            ['completion_pending', actualWeight, request_id, collector_id, 'assigned', 'in_progress']
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found or unauthorized' });
        }
        
        res.json({ success: true, request: result.rows[0], message: 'Waiting for user confirmation' });
    } catch (error) {
        console.error('Error completing request:', error);
        res.status(500).json({ error: 'Failed to complete request' });
    }
});

app.put('/api/requests/respond', async (req, res) => {
    try {
        const { request_id, user_id, action } = req.body; // action: 'accept' or 'reject'
        
        if (!request_id || !user_id || !action) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (action === 'accept') {
            const result = await db.query(
                'UPDATE requests SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
                ['in_progress', request_id, user_id]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Request not found or unauthorized' });
            }
            
            res.json({ success: true, request: result.rows[0] });
        } else if (action === 'reject') {
            const result = await db.query(
                'UPDATE requests SET status = $1, collector_id = NULL, collector_gps = NULL WHERE id = $2 AND user_id = $3 RETURNING *',
                ['pending', request_id, user_id]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Request not found or unauthorized' });
            }
            
            res.json({ success: true, request: result.rows[0] });
        } else {
            return res.status(400).json({ error: 'Invalid action. Must be "accept" or "reject"' });
        }
    } catch (error) {
        console.error('Error responding to request:', error);
        res.status(500).json({ error: 'Failed to respond to request' });
    }
});

app.put('/api/requests/confirm-completion', async (req, res) => {
    res.status(410).json({ error: 'This workflow is retired. Use the v2 weight-confirmation endpoint.' });
});

// ================= Report Environmental Issue =================

app.post("/report", reportUpload.single("image"), async (req, res) => {
    let reportStage = 'image_analysis';
    let storedReportImagePath = null;

    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "Please upload an image."
            });
        }

        const {
            problemType,
            address,
            description,
            latitude,
            longitude,
            capturedAt,
            captureAccuracy,
            captureMethod
        } = req.body;

        if (
            !problemType ||
            !address ||
            !description ||
            !latitude ||
            !longitude
        ) {

            return res.status(400).json({
                success: false,
                error: "Missing required fields."
            });

        }

        const photoLatitude = Number(latitude);
        const photoLongitude = Number(longitude);
        const photoAccuracy = Number(captureAccuracy);
        const photoCapturedAt = new Date(capturedAt);
        if (
            !Number.isFinite(photoLatitude) || photoLatitude < -90 || photoLatitude > 90 ||
            !Number.isFinite(photoLongitude) || photoLongitude < -180 || photoLongitude > 180 ||
            !Number.isFinite(photoAccuracy) || photoAccuracy < 0 ||
            !capturedAt || Number.isNaN(photoCapturedAt.getTime()) ||
            !['camera', 'upload'].includes(captureMethod)
        ) {
            return res.status(400).json({
                success: false,
                error: "Valid photo GPS coordinates, accuracy, and capture time are required."
            });
        }

        console.log("========== New Environmental Report ==========");

        console.log({
            imageMimeType: req.file.mimetype,
            problemType,
            address,
            description,
            latitude,
            longitude: photoLongitude,
            capturedAt: photoCapturedAt.toISOString(),
            captureAccuracy: photoAccuracy,
            captureMethod
        });

        const result = await analyzeImage(req.file.buffer, req.file.mimetype);

        if (!result.contains_trash) {
            return res.status(422).json({
                success: false,
                message: "No visible trash or discarded waste was detected in the uploaded image.",
                ai: result
            });
        }

        reportStage = 'report_storage';
        const imageExtension = REPORT_IMAGE_EXTENSIONS[req.file.mimetype];
        if (!imageExtension) {
            throw new Error('Uploaded report image has an unsupported MIME type.');
        }
        const imageFilename = `${crypto.randomUUID()}${imageExtension}`;
        await fs.promises.mkdir(REPORT_IMAGE_DIR, { recursive: true });
        storedReportImagePath = path.join(REPORT_IMAGE_DIR, imageFilename);
        await fs.promises.writeFile(storedReportImagePath, req.file.buffer, { flag: 'wx' });

        const savedReport = await db.query(
            `INSERT INTO reports
                (problem_type, address, description, image, latitude, longitude,
                 ai_valid, ai_contains_trash, ai_confidence, ai_reason,
                 captured_at, capture_accuracy_m, capture_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING id, created_at`,
            [
                problemType,
                address,
                description,
                imageFilename,
                photoLatitude,
                photoLongitude,
                true,
                true,
                Math.max(0, Math.min(100, Math.round(result.confidence))),
                result.reason,
                photoCapturedAt,
                photoAccuracy,
                captureMethod
            ]
        );
        storedReportImagePath = null;
        res.json({
            success: true,
            message: "Report submitted successfully.",
            ai: result,
            report: {
                id: savedReport.rows[0].id,
                problemType,
                address,
                description,
                latitude: photoLatitude,
                longitude: photoLongitude,
                capturedAt: photoCapturedAt.toISOString(),
                captureAccuracy: photoAccuracy,
                captureMethod,
                submittedAt: savedReport.rows[0].created_at
            }
        });

    } catch (err) {

        if (storedReportImagePath) {
            try {
                await fs.promises.unlink(storedReportImagePath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    console.error('Failed to remove unlinked report image:', {
                        message: cleanupError.message,
                        code: cleanupError.code
                    });
                }
            }
        }

        console.error(`Environmental report ${reportStage} failed:`, {
            message: err.message,
            code: err.code,
            status: err.status
        });

        let statusCode = 500;
        let errorMessage = "The report could not be saved. Check the backend log for database or image-storage errors.";
        if (reportStage === 'image_analysis') {
            statusCode = 503;
            if (err.status === 401 || err.status === 403) {
                errorMessage = `Gemini rejected the API key or its permissions (HTTP ${err.status}). Check that GEMINI_API_KEY is an active Gemini API key and that the Gemini API is enabled.`;
            } else if (err.status === 429) {
                errorMessage = "Gemini API quota or rate limit was reached. Try again later or check your Google AI Studio quota.";
            } else if (err.status === 400) {
                errorMessage = "Gemini rejected the image request (HTTP 400). Check the image format and the backend log for Google's error details.";
            } else if (err.status === 404) {
                errorMessage = "The configured Gemini model is unavailable (HTTP 404). Check GEMINI_MODEL and confirm that the model is available to this API key's project.";
            } else {
                const providerStatus = err.status ? ` (HTTP ${err.status})` : '';
                errorMessage = `Gemini image analysis failed${providerStatus}. Check the backend log for Google's error details and verify the API key and network connection.`;
            }
        }

        res.status(statusCode).json({
            success: false,
            error: errorMessage,
            stage: reportStage,
            providerStatus: reportStage === 'image_analysis' ? (err.status || err.statusCode || null) : undefined
        });

    }

});


const applyPlatformMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '001_platform_core.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

const applyCouponRemovalMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '008_remove_coupons_and_rewards.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

const applyAdminAccountsMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '006_admin_accounts.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

const applyMarketplaceRemovalMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '014_remove_marketplace.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

const applyUnusedSchemaRemovalMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '015_remove_unused_legacy_schema.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

const applyReportCaptureMigration = async () => {
    const migrationPath = path.join(__dirname, 'migrations', '011_report_capture_metadata.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
        await db.query(statement);
    }
};

Promise.all([
    db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT'),
    db.query('ALTER TABLE sellers ADD COLUMN IF NOT EXISTS profile_image TEXT'),
    db.query('ALTER TABLE collectors ADD COLUMN IF NOT EXISTS location_name VARCHAR(255)'),
    db.query('ALTER TABLE collectors ADD COLUMN IF NOT EXISTS profile_image TEXT'),
    db.query('ALTER TABLE collectors ADD COLUMN IF NOT EXISTS age INTEGER'),
    db.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS collected_weight DECIMAL(10,2)')
    ,db.query(`CREATE TABLE IF NOT EXISTS request_collector_candidates (
        id SERIAL PRIMARY KEY,
        request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
        collector_id INTEGER REFERENCES collectors(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (request_id, collector_id)
    )`),
    applyPlatformMigration()
        .then(() => applyCouponRemovalMigration())
        .then(() => applyMarketplaceRemovalMigration())
        .then(() => applyUnusedSchemaRemovalMigration()),
    applyAdminAccountsMigration(),
    applyReportCaptureMigration()
]).then(() => {
    setInterval(processNotificationOutbox, 5000);
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch((error) => {
    console.error('Database migration failed:', error);
    process.exit(1);
});
