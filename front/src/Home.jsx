import React from 'react';
import Hero_section from './Hero_section';
// import Marquee from './Marquee';
import About_section from './About_section';
import Contact_section from './Contact_section';
import OurServices from './OurServices';
import Footer_section from './Footer_section';
import WhyGreenovation from './WhyGreenovation';
import QuizComponent from './QuizComponent';
import GreenovationChatPot from './GreenovationChatPot';
// import Upload_vedio from './Upload_vedio';
import Login from './Login';
import Report from './Report';


const Home = () => {
  return (
    <>
      <Hero_section />
      {/* <Marquee /> */}
     
      <About_section />
      <OurServices />
      <Report/>
      <WhyGreenovation />
      <QuizComponent />
      <GreenovationChatPot />
                  <Login />

      <Contact_section />

      {/* <Upload_vedio /> */}
      <Footer_section />
      
      
    </>
  );
};

export default Home;
