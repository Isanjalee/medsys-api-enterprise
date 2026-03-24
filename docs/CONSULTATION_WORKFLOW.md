# MEDSYS Consultation Workflow

This document explains the current doctor-facing consultation save flow after the introduction of `POST /v1/consultations/save`.

## Goal

Doctors should not have to:
- leave the consultation screen
- create a patient in a separate flow
- search the patient again
- save vitals and allergies as mandatory separate backend steps
- start the visit manually before saving the consultation

The frontend should now treat consultation save as one workflow.

## Backend Endpoint

- `POST /v1/consultations/save`

This endpoint accepts either:
- `patientId` for an existing patient
- `patientDraft` for a patient who does not yet exist

The backend then performs one atomic workflow:
- resolve or create patient
- auto-link guardian by NIC when possible
- reuse or create visit
- create encounter
- save diagnoses
- optionally persist flagged diagnoses into long-term patient conditions
- save tests
- save vitals
- save prescription
- save allergies
- create a patient timeline event
- optionally create a patient history note from `clinicalSummary`

## Frontend Flow

### Existing Patient

1. Doctor searches patient using `GET /v1/search/patients`.
2. Doctor selects a patient.
3. Frontend keeps the selected `patientId`.
4. Frontend sends one `POST /v1/consultations/save` request.

### Patient Not Found

1. Doctor searches patient.
2. If no match is found, stay on the same screen.
3. Show an inline quick-create section.
4. Frontend sends one `POST /v1/consultations/save` request with `patientDraft`.

The doctor should not be redirected into a separate patient registration loop.

## Minimum Patient Draft Fields

Required:
- `name`
- `dateOfBirth`

Optional:
- `nic`
- `gender`
- `phone`
- `mobile`
- `address`
- `bloodGroup`
- `familyId`
- `familyCode`

Important:
- `dateOfBirth` is the canonical identity field
- `age` is optional and only used as a validation helper
- frontend should not rely on age alone for backend save

## Clinical History Behavior

Consultation save now writes patient history in a structured way.

Always:
- encounter and related clinical records
- one `patient_timeline_events` row with `eventKind = consultation`

Optional:
- `clinicalSummary`
  - if sent, backend creates one `patient_history_entries` row
- `persistAsCondition` on a diagnosis row
  - if `true`, backend also creates a `patient_conditions` row

This means frontend does not need a separate manual patient-history save step during the normal doctor workflow.

## Minor Patient Rule

If the patient is under 18 and has no patient NIC, frontend must send:
- `guardianName`
- and either `guardianNic` or `guardianPhone`

Optional:
- `guardianRelationship`
- `guardianPatientId`

Guardian mapping behavior:
- if `guardianPatientId` is provided, backend links to that guardian patient
- if `guardianNic` matches an existing patient, backend auto-links the guardian patient
- if no guardian patient exists, backend stores guardian details directly on the child patient

Frontend does not need to force guardian registration during doctor consultation save.

## Family Behavior

Family linkage rules:
- if guardian is linked to an existing patient with a family, backend reuses that family when possible
- if `familyId` is provided, backend uses it
- if `familyCode` is provided and exists, backend uses it
- if `familyCode` is provided and does not exist, backend creates a new family using that code
- if neither `familyId` nor `familyCode` is present, backend auto-creates a family

This means the doctor flow does not need a mandatory separate family creation step.

## Request Shape

### Existing Patient

```json
{
  "patientId": 123,
  "checkedAt": "2026-03-24T10:30:00Z",
  "reason": "Walk-in consultation",
  "priority": "normal",
  "notes": "Stable",
  "diagnoses": [
    {
      "diagnosisName": "Acute viral fever",
      "icd10Code": "B34.9"
    },
    {
      "diagnosisName": "Bronchial asthma",
      "icd10Code": "J45.909",
      "persistAsCondition": true
    }
  ],
  "vitals": {
    "heartRate": 84,
    "temperatureC": 37.8
  },
  "allergies": [
    {
      "allergyName": "Penicillin",
      "severity": "high",
      "isActive": true
    }
  ],
  "prescription": {
    "items": [
      {
        "drugName": "Paracetamol",
        "dose": "500mg",
        "frequency": "TID",
        "duration": "3 days",
        "quantity": 9,
        "source": "clinical"
      }
    ]
  }
}
```

### New Patient

```json
{
  "patientDraft": {
    "name": "Kamal Silva",
    "dateOfBirth": "1999-06-10",
    "nic": "199912345678",
    "gender": "male",
    "phone": "+94770000001"
  },
  "checkedAt": "2026-03-24T10:30:00Z",
  "reason": "Walk-in consultation",
  "priority": "normal",
  "clinicalSummary": "Seen for walk-in fever review. Supportive care advised.",
  "diagnoses": [
    {
      "diagnosisName": "Acute viral fever",
      "icd10Code": "B34.9"
    }
  ]
}
```

### Minor New Patient

```json
{
  "patientDraft": {
    "name": "Nethmi Silva",
    "dateOfBirth": "2012-04-15",
    "guardianName": "Kasuni Silva",
    "guardianNic": "198812345678",
    "guardianRelationship": "mother"
  },
  "checkedAt": "2026-03-24T10:30:00Z",
  "clinicalSummary": "Child reviewed for fever. Supportive care and hydration advised.",
  "diagnoses": [
    {
      "diagnosisName": "Acute viral fever",
      "icd10Code": "B34.9"
    },
    {
      "diagnosisName": "Childhood asthma",
      "icd10Code": "J45.909",
      "persistAsCondition": true
    }
  ]
}
```

## Frontend UI Recommendation

The doctor screen should have three logical areas:

1. Patient
- search patient
- if not found, show inline quick-create

2. Clinical Data
- vitals
- allergies
- diagnosis
- diagnosis persistence flag for chronic conditions when relevant
- tests
- notes
- clinical summary
- prescription

3. Final Action
- one main button: `Save Consultation`

Avoid forcing these as separate backend save steps during normal doctor workflow:
- `Add Patient`
- `Search Again`
- `Save Vitals`
- `Add Allergies`
- `Start Visit`
- `Save`

Those can still exist as UI sections, but the main backend persistence should be one final consultation save action.

## Response Shape

The endpoint returns:
- `patient`
- `patient_created`
- `visit`
- `encounter_id`
- `prescription_id`
- `vital`

Frontend can use this to:
- show success state
- update selected patient context
- navigate to encounter detail
- open prescription detail if needed

The patient history screens should then read:
- encounter history from encounter data
- timeline from `patient_timeline_events`
- narrative notes from `patient_history_entries`
- chronic conditions from `patient_conditions`

## Engineering Notes

- `POST /v1/appointments`, `POST /v1/visits/start`, and `POST /v1/encounters` remain valid resource-level APIs
- `POST /v1/consultations/save` is the workflow endpoint intended for the doctor screen
- this endpoint is the preferred integration path for walk-in doctor UX
