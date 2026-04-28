const axios = require('axios');
axios.get('https://ml-afiliados-bot-aiao.onrender.com/health', { timeout: 30000 })
  .then(res => console.log('Status:', res.status, 'Data:', res.data))
  .catch(err => {
    if (err.response) {
      console.log('Error Status:', err.response.status);
      console.log('Error Data:', err.response.data);
    } else {
      console.log('Error Message:', err.message);
    }
  });
