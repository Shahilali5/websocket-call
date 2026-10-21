const online = new Map(); // number -> ws
const inCall = new Map(); // number -> callId
const calls = new Map();  // callId -> call object

module.exports = {
  online,
  inCall,
  calls
};
