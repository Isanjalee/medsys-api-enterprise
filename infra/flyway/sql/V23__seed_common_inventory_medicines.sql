DO $$
DECLARE
  v_org UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RETURN;
  END IF;

  INSERT INTO inventory_items (
    organization_id,
    sku,
    name,
    generic_name,
    category,
    dosage_form,
    strength,
    unit,
    stock,
    reorder_level,
    direct_dispense_allowed,
    requires_prescription,
    is_active
  )
  VALUES
    (v_org, 'IBU-400', 'Ibuprofen 400mg', 'Ibuprofen', 'medicine', 'tablet', '400mg', 'tablet', 120.00, 20.00, TRUE, TRUE, TRUE),
    (v_org, 'AMX-500', 'Amoxicillin 500mg', 'Amoxicillin', 'medicine', 'capsule', '500mg', 'capsule', 180.00, 30.00, TRUE, TRUE, TRUE),
    (v_org, 'CET-10', 'Cetirizine 10mg', 'Cetirizine', 'medicine', 'tablet', '10mg', 'tablet', 150.00, 20.00, TRUE, FALSE, TRUE),
    (v_org, 'MET-500', 'Metformin 500mg', 'Metformin', 'medicine', 'tablet', '500mg', 'tablet', 220.00, 40.00, TRUE, TRUE, TRUE),
    (v_org, 'AML-5', 'Amlodipine 5mg', 'Amlodipine', 'medicine', 'tablet', '5mg', 'tablet', 140.00, 25.00, TRUE, TRUE, TRUE),
    (v_org, 'OME-20', 'Omeprazole 20mg', 'Omeprazole', 'medicine', 'capsule', '20mg', 'capsule', 130.00, 25.00, TRUE, FALSE, TRUE),
    (v_org, 'VITC-500', 'Vitamin C 500mg', 'Ascorbic Acid', 'medicine', 'tablet', '500mg', 'tablet', 200.00, 30.00, TRUE, FALSE, TRUE),
    (v_org, 'AZI-500', 'Azithromycin 500mg', 'Azithromycin', 'medicine', 'tablet', '500mg', 'tablet', 90.00, 15.00, TRUE, TRUE, TRUE)
  ON CONFLICT (sku) DO NOTHING;
END $$;

