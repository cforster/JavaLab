var util = require('util');
var ws = require('ws');

exports.attach = function(options) {
}

exports.init = function(done) {
  var app = this;
  initServer(app.server);
  done();
}

var userSockets = {};

exports.labPartsUpdated = function(user, lab, labParts) {
  var userSocketList = userSockets[user];
  if (userSocketList) {
    for (var i = 0; i < userSocketList.length; i++) {
      userSocketList[i].labPartsUpdated(lab, labParts);
    }
  }
}

function initServer(server) {
  var wsServer = new ws.Server({server: server, path: '/userstate'});
  wsServer.on('connection', function(sock) {
    var user = '';

    var sockFuncs = {
      'labPartsUpdated': function(lab, labParts) {
        sock.send(JSON.stringify({'type': 'labPartsUpdated',
                                  'user': user,
                                  'lab': lab,
                                  'labParts': labParts}));
      }
    };

    sock.on('message', function(message) {
      var req;
      try {
        req = JSON.parse(message);
      } catch (e) {
        sock.send(JSON.stringify({'type': 'error',
				  'text': 'Failed to parse request: ' + e}));
        return;
      }

      switch (req.type) {
      case 'user':
        if (user) {
          sock.send(JSON.stringify({'type': 'error',
				    'text': 'User has already been set'}));
          return;
        }
        user = req.user;
        if (user in userSockets) {
          userSockets[user].push(sockFuncs);
        } else {
          userSockets[user] = [sockFuncs];
        }
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

