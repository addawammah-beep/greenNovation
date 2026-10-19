import React from "react";
import "./About_section.css";
import aboutImage from "./photo/aboutimg.jpg";
import Dropdown from 'react-bootstrap/Dropdown';

const AboutSection = () => {
  return (
    <section className="about-section" id="about" aria-label="About Greenovation">
      <div className="section-content">
        <div className="image-container">
          <figure className="about-image-wrapper">
            <img src={aboutImage} alt="Nature and Sustainability" className="about-image" />
          </figure>
        </div>

        <article className="about-details">
          <h2 className="section-title">
            <span className="highlight">ABOUT US</span>
          </h2>
          <p className="text">
            <span className="highlight-large normal-font custom-line-height">
              Towards a Sustainable and Greener Future
            </span>
          </p>

          <div className="benefits">
            <div className="benefit-item">
              <div className="benefit-heading">
                <img 
                  src="https://wp.ditsolution.net/echofy-multi/wp-content/uploads/2024/03/leaf1.png" 
                  alt="" 
                  className="inline-icon" 
                />
                <h3 className="highlight-medium">Economic Benefits</h3>
              </div>
              <p className="italic-text">
                Greenovation makes recycling rewarding: recycle eligible materials, earn money and discounts, and help keep useful resources out of landfills. We hope to add prizes in the future to celebrate even more eco-friendly actions.
              </p>
            </div>

            <div className="benefit-item">
              <div className="benefit-heading">
                <img 
                  src="https://wp.ditsolution.net/echofy-multi/wp-content/uploads/2024/03/hand.png" 
                  alt="" 
                  className="inline-icon" 
                />
                <h3 className="highlight-medium">Safe Environment</h3>
              </div>
              <p className="italic-text">
                Greenovation connects recycling with everyday environmental action. By keeping useful materials in circulation and helping people understand local pollution, we can take practical steps toward cleaner air, water, and soil.
              </p>
            </div>
          </div>

          <p className="pollution-cta-copy">
            Try the Air, Water, and Soil Pollution guides below to discover how polluted your area may be. Answer a few questions to get an estimate and find practical ways to protect your surroundings.
          </p>

          <div className="dropdown-arrow-container">
            <Dropdown>
              <Dropdown.Toggle variant="success" id="dropdown-basic" className="custom-dropdownbtn">
                Explore Pollution Guides <span aria-hidden="true"></span>
              </Dropdown.Toggle>

              <Dropdown.Menu className="dropdownmenu">
                <Dropdown.Item href="https://air-pollution-rouge.vercel.app/" target="_blank" rel="noopener noreferrer">Air Pollution</Dropdown.Item>
                <Dropdown.Item href="https://water-pollution.vercel.app/" target="_blank" rel="noopener noreferrer">Water Pollution</Dropdown.Item>
                <Dropdown.Item href="https://soil-pollution-sage.vercel.app/" target="_blank" rel="noopener noreferrer">Soil Pollution</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
            <img 
              src="https://wp.ditsolution.net/echofy-multi/wp-content/uploads/2024/03/arrow.png" 
              alt="Animated Arrow"
              className="animated-arrow"
            />
          </div>
        </article>
      </div>
    </section>
  );
};

export default AboutSection;
