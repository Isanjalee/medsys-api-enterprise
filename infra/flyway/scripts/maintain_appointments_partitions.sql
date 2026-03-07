-- Create the current month partition plus the next three months.
-- Run this before month-end as part of DB maintenance.
SELECT ensure_appointments_partitions(date_trunc('month', CURRENT_DATE)::DATE, 4);
