import React from 'react';
import './WhyGreenovation.css';

function WhyGreenovation() {
  return (
    <section className="why-greenovation-section" id="why-greenovation">
      <h2 className="why-greenovation-title">WHY GREENOVATION</h2>

      <div className="mindmap-stage">
        <article className="mindmap-card mindmap-card--future">
          <p className="future-plan-label">Future Plans</p>
          <h3>STRATEGIC PARTNERSHIPS</h3>
          <p>
            Greenovation aims to explore collaborations with specialists and innovative organizations whose expertise could support its long-term development.
          </p>
        </article>

        <article className="mindmap-card mindmap-card--becom">
          <h3>Becom — Wael El-Noubi</h3>
          <p className="mindmap-card__focus">Potential Collaboration: Agricultural Waste Transformation</p>
          <p>
            Exploring opportunities to transform agricultural waste into useful materials and higher-value products, supporting resource recovery and circular-economy initiatives.
          </p>
        </article>

        <div className="mindmap-center" aria-label="Greenovation sustainability illustration">
          <img
            src="https://wp.ditsolution.net/echofy-multi/wp-content/uploads/2023/12/skill-thumb.png"
            alt="A plant growing in a hand, representing environmental sustainability"
            className="why-greenovation-main-image"
          />
          <img
            src="https://wp.ditsolution.net/echofy-multi/wp-content/uploads/2024/03/animate.png"
            alt=""
            aria-hidden="true"
            className="why-greenovation-animated-icon"
          />
        </div>

        <article className="mindmap-card mindmap-card--yasmin">
          <h3>Dr. Yasmin Mostafa Yehia</h3>
          <p className="mindmap-card__focus">Potential Collaboration: AI &amp; Advanced Analytics</p>
          <p>
            Exploring the use of artificial intelligence and advanced data analytics to support sustainability indicators, environmental insights, and data-driven reporting.
          </p>
        </article>

        <article className="mindmap-card mindmap-card--difference">
          <div>
            <h3>WHAT MAKES GREENOVATION DIFFERENT?</h3>
            <p className="mindmap-card__note">
              These collaborations are prospective and subject to further discussion and agreement.
            </p>
          </div>
          <p>
            Greenovation turns waste into economic value through a fully digital recycling ecosystem that connects users, collectors, merchants, and recycling businesses. Our goal is to minimize costs and ensure everyone benefits without anyone having to pay out of pocket for someone else&apos;s benefit. Through smart coordination and sustainable funding, we aim to make recycling rewarding, accessible, and beneficial for all.
          </p>
        </article>
      </div>
    </section>
  );
}

export default WhyGreenovation;
