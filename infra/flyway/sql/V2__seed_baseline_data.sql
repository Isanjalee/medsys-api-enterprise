INSERT INTO users (
  organization_id,
  email,
  password_hash,
  first_name,
  last_name,
  role,
  is_active
)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    'owner@medsys.local',
    'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b',
    'System',
    'Owner',
    'owner',
    TRUE
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'doctor@medsys.local',
    'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b',
    'Primary',
    'Doctor',
    'doctor',
    TRUE
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'assistant@medsys.local',
    'sha256:9a4aabf0e5cf71cae2cea646613ce7e2a5919fa758e56819704be25a3a2c1f0b',
    'Clinic',
    'Assistant',
    'assistant',
    TRUE
  )
ON CONFLICT DO NOTHING;

INSERT INTO families (organization_id, family_code, family_name, assigned)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'FAM-0001', 'Perera Family', TRUE),
  ('11111111-1111-1111-1111-111111111111', 'FAM-0002', 'Fernando Family', TRUE)
ON CONFLICT DO NOTHING;

WITH family_ids AS (
  SELECT id, family_code FROM families WHERE organization_id = '11111111-1111-1111-1111-111111111111'
)
INSERT INTO patients (
  organization_id,
  nic,
  first_name,
  last_name,
  dob,
  age,
  gender,
  phone,
  address,
  blood_group,
  family_id,
  is_active
)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    '199012345678',
    'Nimal',
    'Perera',
    '1990-04-12',
    35,
    'male',
    '+94771234567',
    '12 Lake Road, Colombo',
    'O+',
    (SELECT id FROM family_ids WHERE family_code = 'FAM-0001'),
    TRUE
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    '198845612345',
    'Ama',
    'Fernando',
    '1988-09-21',
    37,
    'female',
    '+94779876543',
    '44 Palm Avenue, Galle',
    'A+',
    (SELECT id FROM family_ids WHERE family_code = 'FAM-0002'),
    TRUE
  )
ON CONFLICT DO NOTHING;
