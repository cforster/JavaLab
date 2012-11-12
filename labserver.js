var util = require('util');
var ws = require('ws');

var javarunner = require('./javarunner');
var labdb = require('./labdb');

var MAIN_BOILERPLATE =
  "public class Main {\n" +
  "  public static void main(String[] args) {\n" +
  "    \n" +
  "  }\n" +
  "}\n";

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

    var javaRunner = new javarunner.JavaRunner(function(act) {
      if (sock.readyState != ws.OPEN) return;
      for (var key in act) {
        var msg = {type: key};
        msg[key] = act[key];
        sock.send(JSON.stringify(msg));
      }
    });

    var sockFuncs = {
      'updateLabParts': function(lab, labParts) {
        sock.send(JSON.stringify(
          {type: 'updateLabParts', lab: lab, labParts: labParts}));
      }
    };

    function sendError(errorText, e) {
      if (e) errorText += ': ' + e;
      sock.send(JSON.stringify({type: 'error', text: errorText}));
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
      case 'addLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.getOrCreateUserLab(user, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get user lab', e);
          labInfo.labParts.push(req.partName);
          labdb.updateUserLab(user, lab, labInfo.labParts, function(e) {
            if (e) return sendError('Failed to update user lab', e);
          });
          labdb.populateLabPart(
            user, lab, req.partName, MAIN_BOILERPLATE, function(e) {
              if (e) return sendError('Failed to populate new lab part', e);
            });
          for (var i = 0; i < userSockets[user].length; i++) {
            if (userSockets[user][i] != sockFuncs) {
              userSockets[user][i].updateLabParts(lab, labInfo.labParts);
            }
          }
        });
        break;
      case 'deleteLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.getOrCreateUserLab(user, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get user lab', e);
          var index = labInfo.labParts.indexOf(req.partName);
          if (index == -1) return sendError('Lab part ' + req.partName + ' not found');
          labInfo.labParts.splice(index, 1);
          labdb.updateUserLab(user, lab, labInfo.labParts, function(e) {
            if (e) return sendError('Failed to update user lab', e);
          });
          for (var i = 0; i < userSockets[user].length; i++) {
            if (userSockets[user][i] != sockFuncs) {
              userSockets[user][i].updateLabParts(lab, labInfo.labParts);
            }
          }
        });
        break;
      case 'compileRun':
        javaRunner.compileRun(req.src);
        break;
      case 'stdin':
        javaRunner.stdin(req.stdin);
        break;
      case 'stop':
        javaRunner.stop();
        break;
      }
    });

    sock.on('close', function() {
      javaRunner.stop();
      javaRunner.cleanup();
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

