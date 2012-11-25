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

var nextId = 0;
var userSockets = {};

exports.attach = function(server) {
  var options = {server: server, path: '/labserver'};
  var wss = new ws.Server(options);
  wss.on('connection', function(sock) {
    var id = nextId++;
    util.log('labserver #' + id + ' connected');

    var user = '';
    var lab = '';
    var cursor = null;

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
      },
      'updateLabs': function(labs) {
        sock.send(JSON.stringify({type: 'updateLabs', labs: labs}));
      },
      'cursor': function(cursor) {
        sock.send(JSON.stringify({type: 'cursor', cursor: cursor}));
      },
      'getCursor': function() {
        return cursor;
      },
      'updateCursorId': function(id) {
        if (cursor) {
          cursor.id = id;
        }
      }
    };

    function sendError(errorText, e) {
      if (e) errorText += ': ' + e;
      sock.send(JSON.stringify({type: 'error', text: errorText}));
    }

    function removeFromUserSockets() {
      var userSocketList = userSockets[user];
      if (userSocketList) {
        var pos = userSocketList.indexOf(sockFuncs);
        if (pos == -1) return;
        userSocketList.splice(pos, 1);
        for (var i = 0; i < userSocketList.length; i++) {
          userSocketList[i].cursor({id: userSocketList.length});
          if (i >= pos) {
            userSocketList[i].updateCursorId(i);
            var c = userSocketList[i].getCursor();
            for (var j = 0; j < userSocketList.length; j++) {
              if (i != j) {
                userSocketList[j].cursor(c);
              } else {
                userSocketList[j].cursor({id: j});
              }
            }
          }
        }
      }
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
        if (user) {
          removeFromUserSockets();
        }
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
          labInfo.labParts.push({name: req.partName, predefined: false});
          labdb.updateUserLab(user, lab, labInfo.labParts, function(e) {
            if (e) return sendError('Failed to update user lab', e);
          });
          var mainBoilerplate = MAIN_BOILERPLATE.replace('Main', req.partName);
          labdb.populateLabPart(
            user, lab, req.partName, mainBoilerplate, false, function(e) {
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
          var index = 0;
          while (index < labInfo.labParts.length) {
            if (labInfo.labParts[index].name == req.partName) break;
            ++index;
          }
          if (index == labInfo.labParts.length) {
            return sendError('Lab part ' + req.partName + ' not found');
          }
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
      case 'revertLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.readLabPart(lab, req.partName, function(e, src) {
          if (e) return sendError('Failed to read lab part for lab ' +
                                  lab + ' part ' + req.partName, e);
          labdb.populateLabPart(
            user, lab, req.partName, src, true, function(e) {
              if (e) return sendError('Failed to populate lab part', e);
            });            
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
      case 'setCursor':
        var userSocketList = userSockets[user];
        if (!userSocketList) break;
        var cursorId = userSocketList.indexOf(sockFuncs);
        cursor = {id: cursorId, part: req.part, row: req.row, col: req.col};
        for (var i = 0; i < userSocketList.length; i++) {
          if (userSocketList[i] != sockFuncs) {
            userSocketList[i].cursor(cursor);
          }
        }
        break;
      case 'getCursors':
        var userSocketList = userSockets[user];
        if (!userSocketList) break;
        for (var i = 0; i < userSocketList.length; i++) {
          if (userSocketList[i] != sockFuncs) {
            var c = userSocketList[i].getCursor();
            if (c) {
              sockFuncs.cursor(c);
            }
          }
        }        
        break;
      }
    });

    sock.on('close', function() {
      util.log('labserver #' + id + ' closed');
      javaRunner.stop();
      javaRunner.cleanup();
      removeFromUserSockets();
    });

    sock.on('error', function(reason, errorCode) {
      util.log('labserver #' + id + ' error ' + errorCode + ': ' + reason);
    });

    labdb.listLabs(function(e, labs) {
      if (e) return sendError('Failed to list labs');
      sockFuncs.updateLabs(labs);
    });
  });
}

