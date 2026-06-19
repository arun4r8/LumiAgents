-- Capture SAM notice type so reports can label RFIs / Sources Sought distinctly
-- (you respond to those with a capability statement, not a bid). Nullable; existing
-- rows and SBIR topics that predate this are null. The sweep now sweeps notice types
-- o (Solicitation), p (Presolicitation) and r (Sources Sought / RFI).
--
-- Rollback: ALTER TABLE public.opportunities DROP COLUMN notice_type;

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS notice_type text;
