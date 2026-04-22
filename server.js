require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const twilio = require('twilio');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const allowedOrigins = new Set([
  'https://ktjhair.com',
  'https://www.ktjhair.com',
  'https://sandonman.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  undefined,
]);

app.use(cors({
  origin(origin, callback) {
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const ADMIN_COOKIE_NAME = 'ktj_admin_session';
const ADMIN_HEADER_NAME = 'x-admin-session';
const adminLoginAttempts = new Map();

function signAdminSession(value) {
  return crypto
    .createHmac('sha256', process.env.ADMIN_SESSION_SECRET || 'dev-admin-secret')
    .update(value)
    .digest('hex');
}

function getAdminSessionValue() {
  const marker = 'ktj-admin-authenticated';
  return `${marker}.${signAdminSession(marker)}`;
}

function isAuthorizedAdmin(req) {
  const expected = getAdminSessionValue();
  return req.cookies?.[ADMIN_COOKIE_NAME] === expected || req.headers[ADMIN_HEADER_NAME] === expected;
}

function requireAdmin(req, res, next) {
  if (!isAuthorizedAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

function getAdminCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: Boolean(isProduction),
    path: '/',
    maxAge: 1000 * 60 * 60 * 12,
  };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function getLoginAttemptState(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const existing = adminLoginAttempts.get(ip);

  if (!existing || now > existing.expiresAt) {
    const fresh = { count: 0, expiresAt: now + windowMs, maxAttempts };
    adminLoginAttempts.set(ip, fresh);
    return fresh;
  }

  return existing;
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const ip = getClientIp(req);
  const attemptState = getLoginAttemptState(ip);

  if (attemptState.count >= attemptState.maxAttempts) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait and try again.' });
  }

  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    attemptState.count += 1;
    return res.status(401).json({ error: 'Invalid password.' });
  }

  const sessionValue = getAdminSessionValue();
  adminLoginAttempts.delete(ip);
  res.cookie(ADMIN_COOKIE_NAME, sessionValue, getAdminCookieOptions());

  res.json({ ok: true, sessionToken: sessionValue });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, {
    ...getAdminCookieOptions(),
    maxAge: undefined,
  });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({
    authenticated: isAuthorizedAdmin(req),
    hasCookie: Boolean(req.cookies?.[ADMIN_COOKIE_NAME]),
    hasHeader: Boolean(req.headers[ADMIN_HEADER_NAME]),
    origin: req.headers.origin || null,
  });
});

app.get('/api/admin/bookings', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const bookingsWithImages = await Promise.all((data || []).map(async (booking) => ({
      ...booking,
      current_hair_image_signed_url: await getSignedImageUrl(booking.current_hair_image_url),
      inspiration_image_signed_url: await getSignedImageUrl(booking.inspiration_image_url),
    })));

    res.json({ bookings: bookingsWithImages });
  } catch (error) {
    console.error('Admin bookings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
});

app.get('/api/admin/contact-messages', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('contact_messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ messages: data });
  } catch (error) {
    console.error('Admin contact fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch contact messages.' });
  }
});

app.get('/api/admin/client-notes', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_notes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const notesWithImages = await Promise.all((data || []).map(async (note) => ({
      ...note,
      hair_photo_signed_url: await getSignedImageUrl(note.hair_photo_path),
    })));

    res.json({ notes: notesWithImages });
  } catch (error) {
    console.error('Admin client notes fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch client notes.' });
  }
});

app.get('/api/bookings/availability', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date is required.' });
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('id, appointment_date, appointment_time, service, add_haircut, status')
      .eq('appointment_date', date)
      .order('appointment_time', { ascending: true });

    if (error) throw error;

    res.json({ bookings: data || [] });
  } catch (error) {
    console.error('Availability fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch availability.' });
  }
});

async function uploadFileToBucket(file, folder = 'bookings') {
  if (!file) return null;

  const safeName = `${folder}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const { error } = await supabase.storage
    .from(process.env.SUPABASE_STORAGE_BUCKET)
    .upload(safeName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) throw error;

  return safeName;
}

function getSignedImageUrl(path) {
  if (!path) return null;
  return supabase.storage
    .from(process.env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(path, 60 * 60)
    .then(({ data, error }) => {
      if (error) throw error;
      return data?.signedUrl || null;
    });
}

async function sendEmail({ to, subject, html }) {
  if (!resend || !process.env.RESEND_FROM_EMAIL || !to) return;

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  });
}

function normalizePhoneNumber(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendSms({ to, body }) {
  const normalizedTo = normalizePhoneNumber(to);
  if (!twilioClient || !process.env.TWILIO_FROM_NUMBER || !normalizedTo || !body) return;

  await twilioClient.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to: normalizedTo,
    body,
  });
}

async function sendBookingEmails(booking) {
  const clientHtml = `
    <h2>KTJ Hair Booking Request Received</h2>
    <p>Hi ${booking.name},</p>
    <p>Your booking request has been received.</p>
    <ul>
      <li><strong>Service:</strong> ${booking.service}</li>
      <li><strong>Date:</strong> ${booking.appointment_date}</li>
      <li><strong>Time:</strong> ${booking.appointment_time}</li>
      <li><strong>Status:</strong> ${booking.status || 'new'}</li>
    </ul>
    <p>Katie will follow up if anything needs to be adjusted.</p>
  `;

  const adminHtml = `
    <h2>New Booking Request</h2>
    <ul>
      <li><strong>Name:</strong> ${booking.name}</li>
      <li><strong>Phone:</strong> ${booking.phone}</li>
      <li><strong>Email:</strong> ${booking.email}</li>
      <li><strong>Service:</strong> ${booking.service}</li>
      <li><strong>Date:</strong> ${booking.appointment_date}</li>
      <li><strong>Time:</strong> ${booking.appointment_time}</li>
      <li><strong>Add Haircut:</strong> ${booking.add_haircut ? 'Yes' : 'No'}</li>
      <li><strong>Notes:</strong> ${booking.notes || 'None'}</li>
      <li><strong>Status:</strong> ${booking.status || 'new'}</li>
    </ul>
  `;

  await Promise.allSettled([
    sendEmail({
      to: booking.email,
      subject: 'KTJ Hair booking request received',
      html: clientHtml,
    }),
    sendEmail({
      to: process.env.KATIE_NOTIFICATION_EMAIL,
      subject: 'New KTJ Hair booking request',
      html: adminHtml,
    }),
  ]);
}

async function sendBookingSms(booking) {
  const clientText = `KTJ Hair: Hi ${booking.name}, your booking request for ${booking.service} on ${booking.appointment_date} at ${booking.appointment_time} has been received.`;
  const adminText = `New KTJ Hair booking: ${booking.name}, ${booking.service}, ${booking.appointment_date} at ${booking.appointment_time}. Phone: ${booking.phone}.`;

  await Promise.allSettled([
    sendSms({
      to: booking.phone,
      body: clientText,
    }),
    sendSms({
      to: process.env.KATIE_NOTIFICATION_PHONE,
      body: adminText,
    }),
  ]);
}

async function sendContactEmails(message) {
  const clientHtml = `
    <h2>KTJ Hair Message Received</h2>
    <p>Hi ${message.name},</p>
    <p>Your message has been received. Katie will reply to you soon.</p>
  `;

  const adminHtml = `
    <h2>New Contact Message</h2>
    <ul>
      <li><strong>Name:</strong> ${message.name}</li>
      <li><strong>Email:</strong> ${message.email}</li>
      <li><strong>Phone:</strong> ${message.phone || 'None provided'}</li>
    </ul>
    <p><strong>Message:</strong></p>
    <p>${message.message}</p>
  `;

  await Promise.allSettled([
    sendEmail({
      to: message.email,
      subject: 'KTJ Hair message received',
      html: clientHtml,
    }),
    sendEmail({
      to: process.env.KATIE_NOTIFICATION_EMAIL,
      subject: 'New KTJ Hair contact message',
      html: adminHtml,
    }),
  ]);
}

async function sendContactSms(message) {
  const clientText = `KTJ Hair: Hi ${message.name}, your message has been received. Katie will reply soon.`;
  const adminText = `New KTJ Hair contact message from ${message.name}. Phone: ${message.phone || 'not provided'}. Message: ${message.message}`;

  await Promise.allSettled([
    sendSms({
      to: message.phone,
      body: clientText,
    }),
    sendSms({
      to: process.env.KATIE_NOTIFICATION_PHONE,
      body: adminText,
    }),
  ]);
}

const SERVICE_DURATIONS = {
  haircut: 120,
  'full-highlight': 240,
  'partial-highlight': 180,
  'area-highlight': 120,
  'all-over-color': 120,
  'root-touch-up': 90,
  'partial-highlight-grey': 180,
  'partial highlight': 180,
  'partial highlight/grey coverage': 180,
  gloss: 90,
  'gloss-haircut': 150,
  'gloss and haircut': 150,
  'full highlight': 240,
  'area highlight': 120,
  'all over color': 120,
  'root touch up': 90,
  other: 120,
};

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function normalizeServiceKey(service) {
  return (service || '').trim().toLowerCase();
}

function getServiceDuration(service, addHaircut = false) {
  const baseDuration = SERVICE_DURATIONS[normalizeServiceKey(service)] || SERVICE_DURATIONS.other;
  return baseDuration + (addHaircut ? 30 : 0);
}

function endsByClose(appointmentTime, requestedDuration, closeMinutes = 19 * 60) {
  const requestedStart = timeToMinutes(appointmentTime);
  const requestedEnd = requestedStart + requestedDuration;
  return requestedEnd <= closeMinutes;
}

function hasOverlap(existingBookings, appointmentTime, requestedDuration) {
  const requestedStart = timeToMinutes(appointmentTime);
  const requestedEnd = requestedStart + requestedDuration;

  return existingBookings.some((booking) => {
    const existingStart = timeToMinutes(booking.appointment_time);
    const existingDuration = getServiceDuration(booking.service, booking.add_haircut);
    const existingEnd = existingStart + existingDuration;
    return requestedStart < existingEnd && existingStart < requestedEnd;
  });
}

function hasConflict(existingBookings, appointmentTime, requestedDuration, bufferMinutes = 60) {
  const requestedStart = timeToMinutes(appointmentTime);
  const requestedEnd = requestedStart + requestedDuration;

  return existingBookings.some((booking) => {
    const existingStart = timeToMinutes(booking.appointment_time);
    const existingDuration = getServiceDuration(booking.service, booking.add_haircut);
    const existingEnd = existingStart + existingDuration;

    const requestedBlockedEnd = requestedEnd + bufferMinutes;
    const existingBlockedEnd = existingEnd + bufferMinutes;

    return requestedStart < existingBlockedEnd && existingStart < requestedBlockedEnd;
  });
}

async function findClientRecord({ name, phone }) {
  if (phone) {
    const { data: existingByPhone, error: phoneError } = await supabase
      .from('client_notes')
      .select('id, client_name, client_phone, client_email')
      .eq('client_phone', phone)
      .limit(1);

    if (phoneError) throw phoneError;
    if (existingByPhone && existingByPhone.length > 0) return existingByPhone[0];
  }

  if (name) {
    const { data: existingByName, error: nameError } = await supabase
      .from('client_notes')
      .select('id, client_name, client_phone, client_email')
      .ilike('client_name', name)
      .limit(1);

    if (nameError) throw nameError;
    if (existingByName && existingByName.length > 0) return existingByName[0];
  }

  return null;
}

async function ensureClientRecord({ name, phone, email }) {
  const existingClient = await findClientRecord({ name, phone });
  if (existingClient) return existingClient;

  const { data, error: insertError } = await supabase
    .from('client_notes')
    .insert({
      client_name: name,
      client_phone: phone || null,
      client_email: email || null,
    })
    .select('id, client_name, client_phone, client_email')
    .single();

  if (insertError) throw insertError;
  return data;
}

app.post(
  '/api/bookings',
  upload.fields([
    { name: 'currentHairImage', maxCount: 1 },
    { name: 'inspirationImage', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        name,
        phone,
        email,
        service,
        addHaircut,
        appointmentDate,
        appointmentTime,
        notes,
      } = req.body;

      if (!name || !phone || !email || !service || !appointmentDate || !appointmentTime) {
        return res.status(400).json({ error: 'Missing required booking fields.' });
      }

      const { data: existingBookings, error: fetchError } = await supabase
        .from('bookings')
        .select('appointment_time, service, add_haircut')
        .eq('appointment_date', appointmentDate);

      if (fetchError) throw fetchError;

      const requestedDuration = getServiceDuration(service, addHaircut === 'true' || addHaircut === true);

      if (!endsByClose(appointmentTime, requestedDuration)) {
        return res.status(409).json({ error: 'That appointment would run past 7:00 PM. Please choose an earlier time.' });
      }

      if (hasConflict(existingBookings || [], appointmentTime, requestedDuration, 60)) {
        return res.status(409).json({ error: 'That time is unavailable. Please choose a different appointment time.' });
      }

      const currentHairFile = req.files?.currentHairImage?.[0] || null;
      const inspirationFile = req.files?.inspirationImage?.[0] || null;

      const currentHairImageUrl = await uploadFileToBucket(currentHairFile, 'current-hair');
      const inspirationImageUrl = await uploadFileToBucket(inspirationFile, 'inspiration');

      const { data, error } = await supabase
        .from('bookings')
        .insert({
          name,
          phone,
          email,
          service,
          add_haircut: addHaircut === 'true' || addHaircut === true,
          appointment_date: appointmentDate,
          appointment_time: appointmentTime,
          notes: notes || null,
          current_hair_image_url: currentHairImageUrl,
          inspiration_image_url: inspirationImageUrl,
        })
        .select()
        .single();

      if (error) throw error;

      await ensureClientRecord({ name, phone, email });
      await Promise.allSettled([
        sendBookingEmails(data),
        sendBookingSms(data),
      ]);

      res.status(201).json({ booking: data });
    } catch (error) {
      console.error('Booking submission error:', error);
      res.status(500).json({ error: 'Failed to submit booking.' });
    }
  }
);

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Missing required contact fields.' });
    }

    const { data, error } = await supabase
      .from('contact_messages')
      .insert({
        name,
        email,
        phone: phone || null,
        message,
      })
      .select()
      .single();

    if (error) throw error;

    await Promise.allSettled([
      sendContactEmails(data),
      sendContactSms(data),
    ]);

    res.status(201).json({ message: data });
  } catch (error) {
    console.error('Contact submission error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (!search) {
      return res.json({ clients: [] });
    }

    const { data, error } = await supabase
      .from('client_notes')
      .select('id, client_name, client_phone, client_email')
      .or(`client_name.ilike.%${search}%,client_phone.ilike.%${search}%`)
      .order('client_name', { ascending: true })
      .limit(10);

    if (error) throw error;
    res.json({ clients: data || [] });
  } catch (error) {
    console.error('Admin client search error:', error);
    res.status(500).json({ error: 'Failed to search clients.' });
  }
});

app.post('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const {
      clientMode,
      name,
      phone,
      email,
      service,
      addHaircut,
      appointmentDate,
      appointmentTime,
      notes,
      status,
      skipConfirmation,
    } = req.body;

    let bookingName = name;
    let bookingPhone = phone;
    let bookingEmail = email;

    if (clientMode === 'returning') {
      const selectedClient = await findClientRecord({ name, phone });
      if (!selectedClient) {
        return res.status(400).json({ error: 'Returning client not found.' });
      }
      bookingName = selectedClient.client_name;
      bookingPhone = selectedClient.client_phone;
      bookingEmail = selectedClient.client_email;
    }

    if (!bookingName || !service || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: 'Missing required booking fields.' });
    }

    const { data: existingBookings, error: fetchError } = await supabase
      .from('bookings')
      .select('appointment_time, service, add_haircut')
      .eq('appointment_date', appointmentDate);

    if (fetchError) throw fetchError;

    const requestedDuration = getServiceDuration(service, addHaircut === 'true' || addHaircut === true);
    if (hasOverlap(existingBookings || [], appointmentTime, requestedDuration)) {
      return res.status(409).json({
        error: 'This appointment overlaps an existing booking.',
      });
    }

    const conflict = hasConflict(existingBookings || [], appointmentTime, requestedDuration, 60);
    const endsLate = !endsByClose(appointmentTime, requestedDuration);
    const allowConflict = req.body.allowConflict === 'true' || req.body.allowConflict === true;

    if ((conflict || endsLate) && !allowConflict) {
      const warningParts = [];
      if (conflict) warningParts.push('less than an hour from another booking');
      if (endsLate) warningParts.push('it would end after 7:00 PM');
      return res.status(409).json({
        error: `Warning: this appointment is ${warningParts.join(' and ')}.`,
        needsConfirmation: true,
      });
    }

    const { data, error } = await supabase
      .from('bookings')
      .insert({
        name: bookingName,
        phone: bookingPhone || null,
        email: bookingEmail || null,
        service,
        add_haircut: addHaircut === 'true' || addHaircut === true,
        appointment_date: appointmentDate,
        appointment_time: appointmentTime,
        notes: notes || null,
        status: status || 'new',
      })
      .select()
      .single();

    if (error) throw error;

    await ensureClientRecord({ name: bookingName, phone: bookingPhone, email: bookingEmail });

    if (!(skipConfirmation === 'true' || skipConfirmation === true)) {
      await Promise.allSettled([
        sendBookingEmails(data),
        sendBookingSms(data),
      ]);
    }

    res.status(201).json({ booking: data });
  } catch (error) {
    console.error('Admin booking creation error:', error);
    res.status(500).json({ error: 'Failed to create booking.' });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Booking id is required.' });
    }

    const { error } = await supabase
      .from('bookings')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Admin booking delete error:', error);
    res.status(500).json({ error: 'Failed to delete booking.' });
  }
});

app.post('/api/admin/client-notes', requireAdmin, upload.single('hairPhoto'), async (req, res) => {
  try {
    const {
      clientName,
      clientPhone,
      clientEmail,
      formulaNotes,
      styleNotes,
      generalNotes,
    } = req.body;

    if (!clientName) {
      return res.status(400).json({ error: 'Client name is required.' });
    }

    const hairPhotoPath = await uploadFileToBucket(req.file, 'client-notes');

    const { data, error } = await supabase
      .from('client_notes')
      .insert({
        client_name: clientName,
        client_phone: clientPhone || null,
        client_email: clientEmail || null,
        formula_notes: formulaNotes || null,
        style_notes: styleNotes || null,
        general_notes: generalNotes || null,
        hair_photo_path: hairPhotoPath,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ note: data });
  } catch (error) {
    console.error('Client note creation error:', error);
    res.status(500).json({ error: 'Failed to save client note.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KTJ Hair backend listening on port ${PORT}`);
});
