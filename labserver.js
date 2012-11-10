var util = require('util');
var ws = require('ws');

var labdb = require('./labdb');

exports.attach = function(options) {
}

exports.init = function(done) {
  var app = this;
  initServer(app.server);
  done();
}

var userSockets = {};

function initServer(server) {
  var wsServer = new ws.Server({server: server, path: '/labserver'});
  wsServer.on('connection', function(sock) {
    var user = '';
    var lab = '';

    var sockFuncs = {
      'updateLabParts': function(lab, labParts) {
        sock.send(JSON.stringify(
          {'type': 'updateLabParts', 'lab': lab, 'labParts': labParts}));
      }
    };

    function sendError(errorText, e) {
      if (e) errorText += ': ' + e;
      sock.send(JSON.stringify({'type': 'error', 'text': errorText}));
    }

    sock.on('message', function(message) {
      var req;
      try {
        req = JSON.parse(message);
      } catch (e) {
        return sendError('Failed to parse request', e);
      }

      if (!user && req.type != 'setUser') {
        return sendError('User has not been set');
      }

      switch (req.type) {
      case 'setUser':
        if (user) return sendError('User has already been set');
        user = req.user;
        if (user in userSockets) {
          userSockets[user].push(sockFuncs);
        } else {
          userSockets[user] = [sockFuncs];
        }
        break;
      case 'setLab':
        lab = req.lab;
        labdb.getOrCreateUserLab(user, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get user lab', e);
          sockFuncs.updateLabParts(lab, labInfo.labParts);
        });
        break;
      }
    });

    sock.on('close', function() {
      var userSocketList = userSockets[user];
      if (userSocketList) {
        var pos = userSocketList.indexOf(sockFuncs);
        if (pos != -1) {
          userSocketList.splice(pos, 1);
        }
      }
    });
  });
}

