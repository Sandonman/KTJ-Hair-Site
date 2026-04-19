require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/admin/bookings', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ bookings: data });
  } catch (error) {
    console.error('Admin bookings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
});

app.get('/api/admin/contact-messages', async (_req, res) => {
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

app.get('/api/admin/client-notes', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_notes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ notes: data });
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

async function ensureClientRecord({ name, phone, email }) {
  const { data: existingByPhone, error: phoneError } = await supabase
    .from('client_notes')
    .select('id')
    .eq('client_phone', phone)
    .limit(1);

  if (phoneError) throw phoneError;
  if (existingByPhone && existingByPhone.length > 0) return;

  const { data: existingByName, error: nameError } = await supabase
    .from('client_notes')
    .select('id')
    .ilike('client_name', name)
    .limit(1);

  if (nameError) throw nameError;
  if (existingByName && existingByName.length > 0) return;

  const { error: insertError } = await supabase
    .from('client_notes')
    .insert({
      client_name: name,
      client_phone: phone || null,
      client_email: email || null,
    });

  if (insertError) throw insertError;
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

    res.status(201).json({ message: data });
  } catch (error) {
    console.error('Contact submission error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

app.post('/api/admin/bookings', async (req, res) => {
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
      status,
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
        name,
        phone,
        email,
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

    await ensureClientRecord({ name, phone, email });

    res.status(201).json({ booking: data });
  } catch (error) {
    console.error('Admin booking creation error:', error);
    res.status(500).json({ error: 'Failed to create booking.' });
  }
});

app.delete('/api/admin/bookings/:id', async (req, res) => {
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

app.post('/api/admin/client-notes', upload.single('hairPhoto'), async (req, res) => {
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
