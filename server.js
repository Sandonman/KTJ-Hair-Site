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
      .select('id, appointment_date, appointment_time, service, status')
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

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function hasConflict(existingBookings, appointmentTime, bufferMinutes = 60) {
  const requested = timeToMinutes(appointmentTime);
  return existingBookings.some((booking) => Math.abs(timeToMinutes(booking.appointment_time) - requested) < bufferMinutes);
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
        .select('appointment_time')
        .eq('appointment_date', appointmentDate);

      if (fetchError) throw fetchError;

      if (hasConflict(existingBookings || [], appointmentTime, 60)) {
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
      .select('appointment_time')
      .eq('appointment_date', appointmentDate);

    if (fetchError) throw fetchError;

    const conflict = hasConflict(existingBookings || [], appointmentTime, 60);
    const allowConflict = req.body.allowConflict === 'true' || req.body.allowConflict === true;

    if (conflict && !allowConflict) {
      return res.status(409).json({
        error: 'This appointment is less than an hour from another booking.',
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

    res.status(201).json({ booking: data });
  } catch (error) {
    console.error('Admin booking creation error:', error);
    res.status(500).json({ error: 'Failed to create booking.' });
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
