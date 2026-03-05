DO $$
DECLARE
  v_org UUID := '11111111-1111-1111-1111-111111111111';
  v_owner_id BIGINT;
  v_doctor_id BIGINT;
  v_assistant_id BIGINT;
  v_family_primary_id BIGINT;
  v_family_secondary_id BIGINT;
  v_patient_nimal_id BIGINT;
  v_patient_ama_id BIGINT;
  v_appt_consult_id BIGINT;
  v_appt_waiting_id BIGINT;
  v_encounter_id BIGINT;
  v_prescription_id BIGINT;
  v_inventory_pcm_id BIGINT;
  v_inventory_cbc_id BIGINT;
BEGIN
  INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, is_active)
  VALUES
    (v_org, 'owner@medsys.local', 'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b', 'System', 'Owner', 'owner', TRUE),
    (v_org, 'doctor@medsys.local', 'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b', 'Primary', 'Doctor', 'doctor', TRUE),
    (v_org, 'assistant@medsys.local', 'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b', 'Clinic', 'Assistant', 'assistant', TRUE)
  ON CONFLICT (organization_id, email) DO NOTHING;

  SELECT id INTO v_owner_id FROM users WHERE organization_id = v_org AND email = 'owner@medsys.local' LIMIT 1;
  SELECT id INTO v_doctor_id FROM users WHERE organization_id = v_org AND email = 'doctor@medsys.local' LIMIT 1;
  SELECT id INTO v_assistant_id FROM users WHERE organization_id = v_org AND email = 'assistant@medsys.local' LIMIT 1;

  INSERT INTO families (organization_id, family_code, family_name, assigned)
  VALUES
    (v_org, 'FAM-0001', 'Perera Family', TRUE),
    (v_org, 'FAM-0002', 'Fernando Family', TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_family_primary_id FROM families WHERE organization_id = v_org AND family_code = 'FAM-0001' LIMIT 1;
  SELECT id INTO v_family_secondary_id FROM families WHERE organization_id = v_org AND family_code = 'FAM-0002' LIMIT 1;

  INSERT INTO patients (
    organization_id, nic, first_name, last_name, dob, age, gender, phone, address, blood_group, family_id, is_active
  )
  VALUES
    (v_org, '199012345678', 'Nimal', 'Perera', '1990-04-12', 35, 'male', '+94771234567', '12 Lake Road, Colombo', 'O+', v_family_primary_id, TRUE),
    (v_org, '198845612345', 'Ama', 'Fernando', '1988-09-21', 37, 'female', '+94779876543', '44 Palm Avenue, Galle', 'A+', v_family_secondary_id, TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_patient_nimal_id FROM patients WHERE organization_id = v_org AND nic = '199012345678' LIMIT 1;
  SELECT id INTO v_patient_ama_id FROM patients WHERE organization_id = v_org AND nic = '198845612345' LIMIT 1;

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_primary_id, v_patient_nimal_id, 'self'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_primary_id AND patient_id = v_patient_nimal_id
  );

  INSERT INTO family_members (organization_id, family_id, patient_id, relationship)
  SELECT v_org, v_family_secondary_id, v_patient_ama_id, 'self'
  WHERE NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE organization_id = v_org AND family_id = v_family_secondary_id AND patient_id = v_patient_ama_id
  );

  INSERT INTO patient_allergies (organization_id, patient_id, allergy_name, severity, is_active)
  SELECT v_org, v_patient_nimal_id, 'Penicillin', 'high', TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_allergies
    WHERE organization_id = v_org AND patient_id = v_patient_nimal_id AND allergy_name = 'Penicillin'
  );

  INSERT INTO patient_conditions (organization_id, patient_id, condition_name, icd10_code, status)
  SELECT v_org, v_patient_nimal_id, 'Type 2 Diabetes', 'E11.9', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_conditions
    WHERE organization_id = v_org AND patient_id = v_patient_nimal_id AND condition_name = 'Type 2 Diabetes'
  );

  INSERT INTO appointments (
    organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority
  )
  SELECT v_org, v_patient_nimal_id, v_doctor_id, v_assistant_id, NOW() - INTERVAL '2 hours', 'completed', 'Fever and body pain', 'normal'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org
      AND patient_id = v_patient_nimal_id
      AND reason = 'Fever and body pain'
  );

  SELECT id INTO v_appt_consult_id
  FROM appointments
  WHERE organization_id = v_org
    AND patient_id = v_patient_nimal_id
    AND reason = 'Fever and body pain'
  ORDER BY id DESC
  LIMIT 1;

  INSERT INTO appointments (
    organization_id, patient_id, doctor_id, assistant_id, scheduled_at, status, reason, priority
  )
  SELECT v_org, v_patient_ama_id, v_doctor_id, v_assistant_id, NOW() + INTERVAL '30 minutes', 'waiting', 'Headache follow-up', 'low'
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE organization_id = v_org
      AND patient_id = v_patient_ama_id
      AND reason = 'Headache follow-up'
      AND status = 'waiting'
  );

  SELECT id INTO v_appt_waiting_id
  FROM appointments
  WHERE organization_id = v_org
    AND patient_id = v_patient_ama_id
    AND reason = 'Headache follow-up'
    AND status = 'waiting'
  ORDER BY id DESC
  LIMIT 1;

  INSERT INTO encounters (
    organization_id, appointment_id, patient_id, doctor_id, checked_at, notes, next_visit_date, status
  )
  SELECT v_org, v_appt_consult_id, v_patient_nimal_id, v_doctor_id, NOW() - INTERVAL '90 minutes', 'Viral fever suspected', CURRENT_DATE + INTERVAL '7 days', 'completed'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_consult_id
  );

  SELECT id INTO v_encounter_id FROM encounters WHERE organization_id = v_org AND appointment_id = v_appt_consult_id LIMIT 1;

  INSERT INTO encounter_diagnoses (organization_id, encounter_id, icd10_code, diagnosis_name)
  SELECT v_org, v_encounter_id, 'B34.9', 'Acute viral fever'
  WHERE NOT EXISTS (
    SELECT 1 FROM encounter_diagnoses
    WHERE organization_id = v_org AND encounter_id = v_encounter_id AND diagnosis_name = 'Acute viral fever'
  );

  INSERT INTO test_orders (organization_id, encounter_id, test_name, status)
  SELECT v_org, v_encounter_id, 'CBC', 'ordered'
  WHERE NOT EXISTS (
    SELECT 1 FROM test_orders
    WHERE organization_id = v_org AND encounter_id = v_encounter_id AND test_name = 'CBC'
  );

  INSERT INTO prescriptions (organization_id, encounter_id, patient_id, doctor_id)
  SELECT v_org, v_encounter_id, v_patient_nimal_id, v_doctor_id
  WHERE NOT EXISTS (
    SELECT 1 FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_id
  );

  SELECT id INTO v_prescription_id FROM prescriptions WHERE organization_id = v_org AND encounter_id = v_encounter_id LIMIT 1;

  INSERT INTO prescription_items (organization_id, prescription_id, drug_name, dose, frequency, duration, quantity, source)
  SELECT v_org, v_prescription_id, 'Paracetamol', '500mg', 'TID', '3 days', 9.00, 'clinical'
  WHERE NOT EXISTS (
    SELECT 1 FROM prescription_items
    WHERE organization_id = v_org AND prescription_id = v_prescription_id AND drug_name = 'Paracetamol'
  );

  INSERT INTO prescription_items (organization_id, prescription_id, drug_name, dose, frequency, duration, quantity, source)
  SELECT v_org, v_prescription_id, 'Vitamin C', '500mg', 'BID', '7 days', 14.00, 'outside'
  WHERE NOT EXISTS (
    SELECT 1 FROM prescription_items
    WHERE organization_id = v_org AND prescription_id = v_prescription_id AND drug_name = 'Vitamin C'
  );

  INSERT INTO inventory_items (organization_id, sku, name, category, unit, stock, reorder_level, is_active)
  VALUES
    (v_org, 'PCM-500', 'Paracetamol 500mg', 'medicine', 'tablet', 150.00, 20.00, TRUE),
    (v_org, 'CBC-KIT', 'CBC Test Kit', 'consumable', 'kit', 25.00, 5.00, TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_inventory_pcm_id FROM inventory_items WHERE organization_id = v_org AND sku = 'PCM-500' LIMIT 1;
  SELECT id INTO v_inventory_cbc_id FROM inventory_items WHERE organization_id = v_org AND sku = 'CBC-KIT' LIMIT 1;

  INSERT INTO inventory_movements (
    organization_id, inventory_item_id, movement_type, quantity, reference_type, reference_id, created_by_id
  )
  SELECT v_org, v_inventory_pcm_id, 'in', 150.00, 'adjustment', 1, v_assistant_id
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_movements
    WHERE organization_id = v_org
      AND inventory_item_id = v_inventory_pcm_id
      AND movement_type = 'in'
      AND reference_type = 'adjustment'
      AND reference_id = 1
  );

  INSERT INTO dispense_records (organization_id, prescription_id, assistant_id, dispensed_at, status, notes)
  SELECT v_org, v_prescription_id, v_assistant_id, NOW() - INTERVAL '60 minutes', 'completed', 'Dispensed fully'
  WHERE NOT EXISTS (
    SELECT 1 FROM dispense_records WHERE organization_id = v_org AND prescription_id = v_prescription_id
  );

  INSERT INTO inventory_movements (
    organization_id, inventory_item_id, movement_type, quantity, reference_type, reference_id, created_by_id
  )
  SELECT v_org, v_inventory_pcm_id, 'out', 9.00, 'prescription', v_prescription_id, v_assistant_id
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_movements
    WHERE organization_id = v_org
      AND inventory_item_id = v_inventory_pcm_id
      AND movement_type = 'out'
      AND reference_type = 'prescription'
      AND reference_id = v_prescription_id
  );

  INSERT INTO patient_vitals (
    organization_id, patient_id, encounter_id, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, recorded_at
  )
  SELECT v_org, v_patient_nimal_id, v_encounter_id, 120, 80, 78, 37.2, 98, NOW() - INTERVAL '95 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_vitals
    WHERE organization_id = v_org
      AND patient_id = v_patient_nimal_id
      AND encounter_id = v_encounter_id
  );

  INSERT INTO patient_timeline_events (
    organization_id, patient_id, encounter_id, event_date, title, description, event_kind, tags, value
  )
  SELECT
    v_org,
    v_patient_nimal_id,
    v_encounter_id,
    CURRENT_DATE,
    'Follow-up suggested',
    'Review after one week',
    'checkup',
    ARRAY['followup', 'doctor-note'],
    'review-7-days'
  WHERE NOT EXISTS (
    SELECT 1 FROM patient_timeline_events
    WHERE organization_id = v_org
      AND patient_id = v_patient_nimal_id
      AND title = 'Follow-up suggested'
      AND event_date = CURRENT_DATE
  );

  INSERT INTO refresh_tokens (organization_id, user_id, expires_at)
  SELECT v_org, v_owner_id, NOW() + INTERVAL '7 days'
  WHERE NOT EXISTS (
    SELECT 1 FROM refresh_tokens
    WHERE organization_id = v_org AND user_id = v_owner_id AND revoked_at IS NULL AND expires_at > NOW()
  );

  INSERT INTO audit_logs (
    organization_id, actor_user_id, entity_type, entity_id, action, ip, user_agent, request_id, payload
  )
  SELECT
    v_org,
    v_owner_id,
    'seed',
    v_patient_nimal_id,
    'bootstrap',
    '127.0.0.1'::inet,
    'flyway-seed',
    gen_random_uuid(),
    jsonb_build_object(
      'notes', 'Comprehensive sample dataset inserted',
      'waitingAppointmentId', v_appt_waiting_id,
      'dispensedPrescriptionId', v_prescription_id,
      'inventoryKitId', v_inventory_cbc_id
    )
  WHERE NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE organization_id = v_org
      AND entity_type = 'seed'
      AND action = 'bootstrap'
  );
END $$;
