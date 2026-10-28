-- Serialize administrator-count checks per organization so concurrent
-- membership updates cannot exceed the configured three-admin limit.
CREATE OR REPLACE FUNCTION check_organization_admin_limit()
RETURNS TRIGGER AS $$
DECLARE
    admin_count INTEGER;
BEGIN
    IF NEW.role = 'admin' THEN
        PERFORM pg_advisory_xact_lock(NEW.organization_id);

        SELECT COUNT(*)
        INTO admin_count
        FROM organization_members
        WHERE organization_id = NEW.organization_id
          AND role = 'admin'
          AND id <> COALESCE(NEW.id, -1);

        IF admin_count >= 3 THEN
            RAISE EXCEPTION
                'Organization already has the maximum of 3 administrators';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
