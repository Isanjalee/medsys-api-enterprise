DO $$
DECLARE
  v_org UUID := '11111111-1111-1111-1111-111111111111';
  v_owner_id BIGINT;
  v_doctor_id BIGINT;
  v_assistant_id BIGINT;

  v_family_jayasinghe_id BIGINT;
  v_family_rodrigo_id BIGINT;
  v_family_samarakoon_id BIGINT;

  v_patient_suneth_id BIGINT;
  v_patient_nadeesha_id BIGINT;
  v_patient_dilan_id BIGINT;
  v_patient_mihiri_id BIGINT;
  v_patient_kasun_id BIGINT;

  v_appt_suneth_id BIGINT;
  v_appt_suneth_at TIMESTAMPTZ;
  v_appt_nadeesha_id BIGINT;
  v_appt_nadeesha_at TIMESTAMPTZ;
  v_appt_dilan_id BIGINT;
  v_appt_dilan_at TIMESTAMPTZ;
  v_appt_mihiri_id BIGINT;
  v_appt_mihiri_at TIMESTAMPTZ;
  v_appt_kasun_id BIGINT;
  v_appt_kasun_at TIMESTAMPTZ;

  v_encounter_suneth_id BIGINT;
  v_encounter_dilan_id BIGINT;
  v_encounter_mihiri_id BIGINT;

  v_prescription_suneth_id BIGINT;
  v_prescription_dilan_id BIGINT;
  v_prescription_mihiri_id BIGINT;
BEGIN
  SELECT id INTO v_owner_id FROM users WHERE organization_id = v_org AND email = 'owner@medsys.local' LIMIT 1;
  SELECT id INTO v_doctor_id FROM users WHERE organization_id = v_org AND email = 'doctor@medsys.local' LIMIT 1;
  SELECT id INTO v_assistant_id FROM users WHERE organization_id = v_org AND email = 'assistant@medsys.local' LIMIT 1;

  INSERT INTO families (organization_id, family_code, family_name, assigned)
  VALUES
    (v_org, 'FAM-0003', 'Jayasinghe Family', TRUE),
    (v_org, 'FAM-0004', 'Rodrigo Family', TRUE),
    (v_org, 'FAM-0005', 'Samarakoon Family', TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_family_jayasinghe_id FROM families WHERE organization_id = v_org AND family_code = 'FAM-0003' LIMIT 1;
  SELECT id INTO v_family_rodrigo_id FROM families WHERE organization_id = v_org AND family_code = 'FAM-0004' LIMIT 1;
  SELECT id INTO v_family_samarakoon_id FROM families WHERE organization_id = v_org AND family_code = 'FAM-0005' LIMIT 1;

  INSERT INTO patients (
    organization_id, nic, first_name, last_name, dob, age, gender, phone, address, blood_group, family_id, is_active
  )
  VALUES
    (
      v_org,
      '199105140111',
      'Suneth',
      'Jayasinghe',
      '1991-05-14',
      EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1991-05-14'))::SMALLINT,
      'male',
      '+94771110001',
      '18 Temple Road, Kandy',
      'B+',
      v_family_jayasinghe_id,
      TRUE
    ),
    (
      v_org,
      '199402270222',
      'Nadeesha',
      'Jayasinghe',
      '1994-02-27',
      EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1994-02-27'))::SMALLINT,
      'female',
      '+94771110002',
      '18 Temple Road, Kandy',
      'AB+',
      v_family_jayasinghe_id,
      TRUE
    ),
    (
      v_org,
      '198711030333',
      'Dilan',
      'Rodrigo',
      '1987-11-03',
      EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1987-11-03'))::SMALLINT,
      'male',
      '+94771110003',
      '221 Harbour Street, Negombo',
      'O-',
      v_family_rodrigo_id,
      TRUE
    ),
    (
      v_org,
      '199611220444',
      'Mihiri',
      'Peris',
      '1996-11-22',
      EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1996-11-22'))::SMALLINT,
      'female',
      '+94771110004',
      '77 Lotus Avenue, Matara',
      'A-',
      v_family_samarakoon_id,
      TRUE
    ),
    (
      v_org,
      '200001150555',
      'Kasun',
      'Samarakoon',
      '2000-01-15',
      EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '2000-01-15'))::SMALLINT,
      'male',
      '+94771110005',
      '77 Lotus Avenue, Matara',
      'B-',
      v_family_samarakoon_id,
      TRUE
    )
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_patient_suneth_id FROM patients WHERE organization_id = v_org AND nic = '199105140111' LIMIT 1;
  SELECT id INTO v_patient_nadeesha_id FROM patients WHERE organization_id = v_org AND nic = '199402270222' LIMIT 1;
  SELECT id INTO v_patient_dilan_id FROM patients WHERE organization_id = v_org AND nic = '198711030333' LIMIT 1;
  SELECT id INTO v_patient_mihiri_id FROM patients WHERE organization_id = v_org AND nic = '199611220444' LIMIT 1;
  SELECT id INTO v_patient_kasun_id FROM patients WHERE organization_id = v_org AND nic = '200001150555' LIMIT 1;

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_jayasinghe_id, v_patient_suneth_id, 'self'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_jayasinghe_id AND patient_id = v_patient_suneth_id
  );

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_jayasinghe_id, v_patient_nadeesha_id, 'spouse'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_jayasinghe_id AND patient_id = v_patient_nadeesha_id
  );

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_rodrigo_id, v_patient_dilan_id, 'self'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_rodrigo_id AND patient_id = v_patient_dilan_id
  );

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_samarakoon_id, v_patient_mihiri_id, 'self'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_samarakoon_id AND patient_id = v_patient_mihiri_id
  );

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_samarakoon_id, v_patient_kasun_id, 'spouse'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_samarakoon_id AND patient_id = v_patient_kasun_id
  );

  INSERT INTO patient_history_entries (organization_id, patient_id, created_by_user_id, note)
  SELECT v_org, v_patient_suneth_id, v_owner_id, 'Known for regular blood pressure monitoring and medication review.'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_history_entries
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND note = 'Known for regular blood pressure monitoring and medication review.'
  );

  INSERT INTO patient_history_entries (organization_id, patient_id, created_by_user_id, note)
  SELECT v_org, v_patient_nadeesha_id, v_assistant_id, 'Reported sinus congestion for four days and requested an early morning review.'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_history_entries
    WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND note = 'Reported sinus congestion for four days and requested an early morning review.'
  );

  INSERT INTO patient_history_entries (organization_id, patient_id, created_by_user_id, note)
  SELECT v_org, v_patient_dilan_id, v_owner_id, 'Asthma inhaler use reviewed after recent weather-triggered wheezing.'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_history_entries
    WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND note = 'Asthma inhaler use reviewed after recent weather-triggered wheezing.'
  );

  INSERT INTO patient_history_entries (organization_id, patient_id, created_by_user_id, note)
  SELECT v_org, v_patient_mihiri_id, v_assistant_id, 'Complained of persistent fatigue and dizziness during follow-up.'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_history_entries
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND note = 'Complained of persistent fatigue and dizziness during follow-up.'
  );

  INSERT INTO patient_history_entries (organization_id, patient_id, created_by_user_id, note)
  SELECT v_org, v_patient_kasun_id, v_owner_id, 'History of migraine episodes linked to poor sleep and dehydration.'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_history_entries
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND note = 'History of migraine episodes linked to poor sleep and dehydration.'
  );

  INSERT INTO patient_allergies (organization_id, patient_id, allergy_name, severity, is_active)
  SELECT v_org, v_patient_suneth_id, 'Dust', 'low', TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_allergies
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND allergy_name = 'Dust'
  );

  INSERT INTO patient_allergies (organization_id, patient_id, allergy_name, severity, is_active)
  SELECT v_org, v_patient_nadeesha_id, 'Peanuts', 'moderate', TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_allergies
    WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND allergy_name = 'Peanuts'
  );

  INSERT INTO patient_allergies (organization_id, patient_id, allergy_name, severity, is_active)
  SELECT v_org, v_patient_mihiri_id, 'Penicillin', 'high', TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_allergies
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND allergy_name = 'Penicillin'
  );

  INSERT INTO patient_allergies (organization_id, patient_id, allergy_name, severity, is_active)
  SELECT v_org, v_patient_kasun_id, 'Latex', 'low', TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_allergies
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND allergy_name = 'Latex'
  );

  INSERT INTO patient_conditions (organization_id, patient_id, condition_name, icd10_code, status)
  SELECT v_org, v_patient_suneth_id, 'Hypertension', 'I10', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_conditions
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND condition_name = 'Hypertension'
  );

  INSERT INTO patient_conditions (organization_id, patient_id, condition_name, icd10_code, status)
  SELECT v_org, v_patient_dilan_id, 'Asthma', 'J45.909', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_conditions
    WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND condition_name = 'Asthma'
  );

  INSERT INTO patient_conditions (organization_id, patient_id, condition_name, icd10_code, status)
  SELECT v_org, v_patient_mihiri_id, 'Iron deficiency anemia', 'D50.9', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_conditions
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND condition_name = 'Iron deficiency anemia'
  );

  INSERT INTO patient_conditions (organization_id, patient_id, condition_name, icd10_code, status)
  SELECT v_org, v_patient_kasun_id, 'Migraine', 'G43.909', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_conditions
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND condition_name = 'Migraine'
  );

  INSERT INTO appointments (organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority)
  SELECT v_org, v_patient_suneth_id, v_doctor_id, v_assistant_id, NOW() - INTERVAL '36 hours', 'completed', 'Annual blood pressure review', 'normal'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND reason = 'Annual blood pressure review'
  );

  INSERT INTO appointments (organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority)
  SELECT v_org, v_patient_nadeesha_id, v_doctor_id, v_assistant_id, NOW() + INTERVAL '4 hours', 'waiting', 'Sinus discomfort assessment', 'low'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND reason = 'Sinus discomfort assessment' AND status = 'waiting'
  );

  INSERT INTO appointments (organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority)
  SELECT v_org, v_patient_dilan_id, v_doctor_id, v_assistant_id, NOW() - INTERVAL '20 hours', 'completed', 'Wheezing and cough review', 'high'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND reason = 'Wheezing and cough review'
  );

  INSERT INTO appointments (organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority)
  SELECT v_org, v_patient_mihiri_id, v_doctor_id, v_assistant_id, NOW() - INTERVAL '10 hours', 'completed', 'Fatigue and dizziness review', 'normal'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND reason = 'Fatigue and dizziness review'
  );

  INSERT INTO appointments (organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority)
  SELECT v_org, v_patient_kasun_id, v_doctor_id, v_assistant_id, NOW() + INTERVAL '1 day', 'waiting', 'Migraine follow-up', 'normal'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND reason = 'Migraine follow-up' AND status = 'waiting'
  );

  SELECT id, scheduled_at INTO v_appt_suneth_id, v_appt_suneth_at
  FROM appointments
  WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND reason = 'Annual blood pressure review'
  ORDER BY id DESC
  LIMIT 1;

  SELECT id, scheduled_at INTO v_appt_nadeesha_id, v_appt_nadeesha_at
  FROM appointments
  WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND reason = 'Sinus discomfort assessment'
  ORDER BY id DESC
  LIMIT 1;

  SELECT id, scheduled_at INTO v_appt_dilan_id, v_appt_dilan_at
  FROM appointments
  WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND reason = 'Wheezing and cough review'
  ORDER BY id DESC
  LIMIT 1;

  SELECT id, scheduled_at INTO v_appt_mihiri_id, v_appt_mihiri_at
  FROM appointments
  WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND reason = 'Fatigue and dizziness review'
  ORDER BY id DESC
  LIMIT 1;

  SELECT id, scheduled_at INTO v_appt_kasun_id, v_appt_kasun_at
  FROM appointments
  WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND reason = 'Migraine follow-up'
  ORDER BY id DESC
  LIMIT 1;

  INSERT INTO encounters (
    organization_id, appointment_id, appointment_scheduled_at, patient_id, doctor_id, checked_at, notes, next_visit_date, status
  )
  SELECT
    v_org,
    v_appt_suneth_id,
    v_appt_suneth_at,
    v_patient_suneth_id,
    v_doctor_id,
    v_appt_suneth_at + INTERVAL '25 minutes',
    'Blood pressure remains borderline elevated. Continue medication and lifestyle changes.',
    CURRENT_DATE + INTERVAL '30 days',
    'completed'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_suneth_id
  );

  INSERT INTO encounters (
    organization_id, appointment_id, appointment_scheduled_at, patient_id, doctor_id, checked_at, notes, next_visit_date, status
  )
  SELECT
    v_org,
    v_appt_dilan_id,
    v_appt_dilan_at,
    v_patient_dilan_id,
    v_doctor_id,
    v_appt_dilan_at + INTERVAL '18 minutes',
    'Mild asthma flare after dust exposure. Nebulization not required.',
    CURRENT_DATE + INTERVAL '14 days',
    'completed'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_dilan_id
  );

  INSERT INTO encounters (
    organization_id, appointment_id, appointment_scheduled_at, patient_id, doctor_id, checked_at, notes, next_visit_date, status
  )
  SELECT
    v_org,
    v_appt_mihiri_id,
    v_appt_mihiri_at,
    v_patient_mihiri_id,
    v_doctor_id,
    v_appt_mihiri_at + INTERVAL '22 minutes',
    'Symptoms are consistent with iron deficiency. Recommended dietary review and supplementation.',
    CURRENT_DATE + INTERVAL '21 days',
    'completed'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_mihiri_id
  );

  SELECT id INTO v_encounter_suneth_id FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_suneth_id LIMIT 1;
  SELECT id INTO v_encounter_dilan_id FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_dilan_id LIMIT 1;
  SELECT id INTO v_encounter_mihiri_id FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_mihiri_id LIMIT 1;

  INSERT INTO encounter_diagnoses (organization_id, encounter_id, icd10_code, diagnosis_name)
  SELECT v_org, v_encounter_suneth_id, 'I10', 'Essential hypertension'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounter_diagnoses
    WHERE organization_id = v_org AND encounter_id = v_encounter_suneth_id AND diagnosis_name = 'Essential hypertension'
  );

  INSERT INTO encounter_diagnoses (organization_id, encounter_id, icd10_code, diagnosis_name)
  SELECT v_org, v_encounter_dilan_id, 'J45.901', 'Mild asthma exacerbation'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounter_diagnoses
    WHERE organization_id = v_org AND encounter_id = v_encounter_dilan_id AND diagnosis_name = 'Mild asthma exacerbation'
  );

  INSERT INTO encounter_diagnoses (organization_id, encounter_id, icd10_code, diagnosis_name)
  SELECT v_org, v_encounter_mihiri_id, 'D50.9', 'Iron deficiency anemia'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounter_diagnoses
    WHERE organization_id = v_org AND encounter_id = v_encounter_mihiri_id AND diagnosis_name = 'Iron deficiency anemia'
  );

  INSERT INTO test_orders (organization_id, encounter_id, test_name, status)
  SELECT v_org, v_encounter_suneth_id, 'Lipid Profile', 'ordered'
  WHERE NOT EXISTS (
    SELECT 1 FROM test_orders
    WHERE organization_id = v_org AND encounter_id = v_encounter_suneth_id AND test_name = 'Lipid Profile'
  );

  INSERT INTO test_orders (organization_id, encounter_id, test_name, status)
  SELECT v_org, v_encounter_dilan_id, 'Spirometry', 'ordered'
  WHERE NOT EXISTS (
    SELECT 1 FROM test_orders
    WHERE organization_id = v_org AND encounter_id = v_encounter_dilan_id AND test_name = 'Spirometry'
  );

  INSERT INTO test_orders (organization_id, encounter_id, test_name, status)
  SELECT v_org, v_encounter_mihiri_id, 'CBC', 'ordered'
  WHERE NOT EXISTS (
    SELECT 1 FROM test_orders
    WHERE organization_id = v_org AND encounter_id = v_encounter_mihiri_id AND test_name = 'CBC'
  );

  INSERT INTO prescriptions (organization_id, encounter_id, patient_id, doctor_id)
  SELECT v_org, v_encounter_suneth_id, v_patient_suneth_id, v_doctor_id
  WHERE NOT EXISTS (
    SELECT 1 FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_suneth_id
  );

  INSERT INTO prescriptions (organization_id, encounter_id, patient_id, doctor_id)
  SELECT v_org, v_encounter_dilan_id, v_patient_dilan_id, v_doctor_id
  WHERE NOT EXISTS (
    SELECT 1 FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_dilan_id
  );

  INSERT INTO prescriptions (organization_id, encounter_id, patient_id, doctor_id)
  SELECT v_org, v_encounter_mihiri_id, v_patient_mihiri_id, v_doctor_id
  WHERE NOT EXISTS (
    SELECT 1 FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_mihiri_id
  );

  SELECT id INTO v_prescription_suneth_id FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_suneth_id LIMIT 1;
  SELECT id INTO v_prescription_dilan_id FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_dilan_id LIMIT 1;
  SELECT id INTO v_prescription_mihiri_id FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_mihiri_id LIMIT 1;

  INSERT INTO prescription_items (organization_id, prescription_id, drug_name, dose, frequency, duration, quantity, source)
  SELECT v_org, v_prescription_suneth_id, 'Amlodipine', '5mg', 'OD', '30 days', 30.00, 'clinical'
  WHERE NOT EXISTS (
    SELECT 1 FROM prescription_items
    WHERE organization_id = v_org AND prescription_id = v_prescription_suneth_id AND drug_name = 'Amlodipine'
  );

  INSERT INTO prescription_items (organization_id, prescription_id, drug_name, dose, frequency, duration, quantity, source)
  SELECT v_org, v_prescription_dilan_id, 'Salbutamol Inhaler', '100mcg', 'PRN', '14 days', 1.00, 'outside'
  WHERE NOT EXISTS (
    SELECT 1 FROM prescription_items
    WHERE organization_id = v_org AND prescription_id = v_prescription_dilan_id AND drug_name = 'Salbutamol Inhaler'
  );

  INSERT INTO prescription_items (organization_id, prescription_id, drug_name, dose, frequency, duration, quantity, source)
  SELECT v_org, v_prescription_mihiri_id, 'Ferrous Sulphate', '200mg', 'BID', '30 days', 60.00, 'clinical'
  WHERE NOT EXISTS (
    SELECT 1 FROM prescription_items
    WHERE organization_id = v_org AND prescription_id = v_prescription_mihiri_id AND drug_name = 'Ferrous Sulphate'
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_suneth_id, v_encounter_suneth_id, 138, 88, 76, 36.9, 98, v_appt_suneth_at + INTERVAL '20 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND recorded_at = v_appt_suneth_at + INTERVAL '20 minutes'
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_nadeesha_id, NULL, 118, 76, 82, 36.8, 99, NOW() - INTERVAL '30 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND recorded_at > NOW() - INTERVAL '2 hours'
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_dilan_id, v_encounter_dilan_id, 124, 82, 96, 37.1, 97, v_appt_dilan_at + INTERVAL '15 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND recorded_at = v_appt_dilan_at + INTERVAL '15 minutes'
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_mihiri_id, v_encounter_mihiri_id, 110, 72, 84, 36.7, 99, v_appt_mihiri_at + INTERVAL '18 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND recorded_at = v_appt_mihiri_at + INTERVAL '18 minutes'
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_kasun_id, NULL, 122, 80, 74, 36.6, 99, NOW() - INTERVAL '45 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND recorded_at > NOW() - INTERVAL '2 hours'
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_suneth_id,
    v_encounter_suneth_id,
    CURRENT_DATE - 1,
    'Lifestyle review advised',
    'Reduce salt intake and continue daily exercise tracking.',
    'followup',
    ARRAY['hypertension', 'counselling'],
    'salt-reduction-plan'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org AND patient_id = v_patient_suneth_id AND title = 'Lifestyle review advised'
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_nadeesha_id,
    NULL,
    CURRENT_DATE,
    'ENT review scheduled',
    'Booked for sinus discomfort review later today.',
    'appointment',
    ARRAY['sinus', 'waiting'],
    'ent-review'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org AND patient_id = v_patient_nadeesha_id AND title = 'ENT review scheduled'
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_dilan_id,
    v_encounter_dilan_id,
    CURRENT_DATE,
    'Inhaler technique reinforced',
    'Reviewed rescue inhaler usage and trigger avoidance.',
    'education',
    ARRAY['asthma', 'education'],
    'inhaler-teachback'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org AND patient_id = v_patient_dilan_id AND title = 'Inhaler technique reinforced'
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_mihiri_id,
    v_encounter_mihiri_id,
    CURRENT_DATE,
    'Iron therapy started',
    'Supplementation initiated with repeat CBC planned.',
    'treatment',
    ARRAY['anemia', 'supplement'],
    'iron-therapy'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org AND patient_id = v_patient_mihiri_id AND title = 'Iron therapy started'
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_kasun_id,
    NULL,
    CURRENT_DATE + 1,
    'Sleep hygiene review pending',
    'Migraine review includes hydration and sleep counselling.',
    'followup',
    ARRAY['migraine', 'sleep'],
    'sleep-hygiene'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org AND patient_id = v_patient_kasun_id AND title = 'Sleep hygiene review pending'
  );
END $$;
