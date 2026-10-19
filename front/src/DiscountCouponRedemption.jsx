import { useState } from 'react';
import './DiscountCouponRedemption.css';

const API_BASE = 'http://localhost:4000/api/v2/seller/discount-coupons';

const DiscountCouponRedemption = () => {
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState(null);
  const [loading, setLoading] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem('greenovation_token') || ''}`
  });

  const handleLookup = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setCoupon(null);
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) {
      setError('Enter a coupon code first.');
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/${encodeURIComponent(normalizedCode)}`, {
        headers: getHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not find this coupon.');
      if (!data.coupon) throw new Error('The server did not return coupon details.');
      setCoupon(data.coupon);
      setCode(normalizedCode);
    } catch (lookupError) {
      setError(lookupError.message || 'Could not look up coupon.');
    } finally {
      setLoading(false);
    }
  };

  const handleRedeem = async () => {
    if (!coupon || coupon.status !== 'active') return;
    setError('');
    setSuccess('');

    try {
      setRedeeming(true);
      const response = await fetch(`${API_BASE}/${encodeURIComponent(coupon.code)}/redeem`, {
        method: 'POST',
        headers: getHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not redeem this coupon.');
      if (!data.coupon) throw new Error('The server did not return the redeemed coupon.');
      setCoupon(data.coupon);
      setSuccess('Coupon redeemed. Apply the 20% discount to this purchase.');
    } catch (redemptionError) {
      setError(redemptionError.message || 'Could not redeem coupon.');
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <section className="seller-discount-coupon" aria-labelledby="seller-discount-coupon-title">
      <h3 id="seller-discount-coupon-title">Redeem a customer coupon</h3>
      <p>Look up the customer and their points balance. A successful redemption gives 20% off and uses all of their current points.</p>
      <form className="seller-discount-coupon-form" onSubmit={handleLookup}>
        <label htmlFor="seller-discount-coupon-code">Coupon number</label>
        <div>
          <input
            id="seller-discount-coupon-code"
            value={code}
            onChange={event => {
              setCode(event.target.value.toUpperCase());
              setCoupon(null);
              setError('');
              setSuccess('');
            }}
            placeholder="Enter the customer coupon number"
            autoComplete="off"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Searching...' : 'Search coupon'}
          </button>
        </div>
      </form>
      {error && <p className="seller-discount-coupon-error" role="alert">{error}</p>}
      {success && <p className="seller-discount-coupon-success" role="status">{success}</p>}
      {coupon && (
        <article className="seller-discount-coupon-result">
          <h4>Coupon details</h4>
          <p><b>Customer:</b> {coupon.user_name || 'Customer'}</p>
          <p><b>Email:</b> {coupon.user_email || 'Not provided'}</p>
          <p><b>Current points:</b> {Number(coupon.points || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}</p>
          <p><b>Discount:</b> {coupon.discount_percent}%</p>
          <p><b>Status:</b> {coupon.status === 'active' ? 'Ready to redeem' : 'Already redeemed'}</p>
          {coupon.status === 'redeemed' && (
            <p><b>Points used:</b> {Number(coupon.points_deducted || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}</p>
          )}
          <button
            type="button"
            disabled={redeeming || coupon.status !== 'active'}
            onClick={handleRedeem}
          >
            {redeeming ? 'Redeeming...' : coupon.status === 'active' ? 'Apply 20% discount and redeem' : 'Already redeemed'}
          </button>
        </article>
      )}
    </section>
  );
};

export default DiscountCouponRedemption;
