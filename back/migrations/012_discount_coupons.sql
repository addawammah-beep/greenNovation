CREATE TABLE IF NOT EXISTS discount_coupons (
  code VARCHAR(32) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redeemed')),
  discount_percent SMALLINT NOT NULL DEFAULT 20
    CHECK (discount_percent = 20),
  points_deducted DECIMAL(12,3) NOT NULL DEFAULT 0
    CHECK (points_deducted >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_at TIMESTAMP,
  redeemed_by INTEGER REFERENCES sellers(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_coupons_one_active_per_user
  ON discount_coupons(user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_discount_coupons_user_created
  ON discount_coupons(user_id, created_at DESC);
