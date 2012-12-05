var _ = require('underscore')._;
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
var homes = {};

labdb.eventEmitter.once('open', function() {
  labdb.listHomes(function(e, homeNames) {
    if (e) throw "Failed to list homes: " + e;
    _.each(homeNames, function(homeName) {
      if (!(homeName in homes)) {
        homes[homeName] = { name: homeName, socks: [] };
      }
    });
  });
});

exports.attach = function(server) {
  var options = {server: server, path: '/labserver'};
  var wss = new ws.Server(options);
  wss.on('connection', function(sock) {
    var id = nextId++;
    util.log('labserver #' + id + ' connected');

    var user = '';
    var home = null;
    var lab = '';
    var cursor = {};

    var javaRunner = new javarunner.JavaRunner(function(act) {
      if (sock.readyState != ws.OPEN) return;
      for (var key in act) {
        var msg = {type: key};
        msg[key] = act[key];
        sock.send(JSON.stringify(msg));
      }
    });

    var sockExports = {
      'getCursor': function() {
        return cursor;
      },
      'setCursorId': function(id) {
        cursor.id = id;
      },
      'updateCursor': function(cursor) {
        sock.send(JSON.stringify({type: 'update', cursor: cursor}));
      },
      'updateHomes': function() {
        sock.send(JSON.stringify(
          {type: 'update', homes: _.map(homes, function(home) {
            return { name: home.name,
                     users: home.socks.length };
          })}));
      },
      'updateLabs': function(labs) {
        sock.send(JSON.stringify({type: 'update', labs: labs}));
      },
      'updateLabParts': function(labToUpdate, labParts) {
        if (lab != labToUpdate) return;
        sock.send(JSON.stringify({type: 'update', labParts: labParts}));
      }
    };

    function sendError(errorText, e) {
      if (e) errorText += ': ' + e;
      sock.send(JSON.stringify({type: 'error', text: errorText}));
    }
 
    function addToHome(homeName) {
      if (!(homeName in homes)) {
        homes[homeName] = {
          name: homeName,
          socks: []
        }
      }
      home = homes[homeName];
      home.socks.push(sockExports);
      cursor = {id: home.socks.length - 1};
      _.each(homes, function(home) {
        _.each(home.socks, function(sock) {
          sock.updateHomes();
        });
      });
    }
    
    function removeFromHome() {
      if (!home) return;
      var pos = home.socks.indexOf(sockExports);
      if (pos == -1) return;
      home.socks.splice(pos, 1);
      // renumber the cursors of connections >= pos
      _.each(_.rest(home.socks, pos), function(sock, i) {
        sock.setCursorId(i + pos);
      });
      _.each(home.socks, function(sock) {
        // remove the highest numbered cursor from each connection
        sock.updateCursor({id: home.socks.length});
        // resend all cursors >= pos to all connections
        _.each(_.rest(home.socks, pos), function(cursorSock, i) {
          if (cursorSock != sock) {
            sock.updateCursor(cursorSock.getCursor());
          } else {
            sock.updateCursor({id: i + pos});
          }
        });
      });
      _.each(homes, function(home) {
        _.each(home.socks, function(sock) {
          sock.updateHomes();
        });
      });
    }
 
    sock.on('message', function(message) {
      var req;
      try {
        req = JSON.parse(message);
      } catch (e) {
        return sendError('Failed to parse request', e);
      }

      if (!home && req.type != 'setHome' && req.type != 'setUser') {
        return sendError('Home has not been set');
      }

      switch (req.type) {
      case 'setUser':
        user = req.user;
        break;
      case 'setHome':
        removeFromHome();
        addToHome(req.home);
        if (lab) {
          labdb.getOrCreateHomeLab(home.name, lab, function(e, labInfo) {
            if (e) return sendError('Failed to get home lab', e);
            sockExports.updateLabParts(lab, labInfo.labParts);
          });
        }
        break;
      case 'setLab':
        lab = req.lab;
        labdb.getOrCreateHomeLab(home.name, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          sockExports.updateLabParts(lab, labInfo.labParts);
        });
        break;
      case 'addLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.getOrCreateHomeLab(home.name, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          labInfo.labParts.push({name: req.partName, predefined: false});
          labdb.updateHomeLab(home.name, lab, labInfo.labParts, function(e) {
            if (e) return sendError('Failed to update home lab', e);
          });
          var mainBoilerplate = MAIN_BOILERPLATE.replace('Main', req.partName);
          labdb.populateLabPart(
            home.name, lab, req.partName, mainBoilerplate, false, function(e) {
              if (e) return sendError('Failed to populate new lab part', e);
            });
          _.each(home.socks, function(sock) {
            sock.updateLabParts(lab, labInfo.labParts);
          });
        });
        break;
      case 'deleteLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.getOrCreateHomeLab(home.name, lab, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          var newLabParts = _.reject(labInfo.labParts, function(labPart) {
            return labPart.name == req.partName;
          });
          if (labInfo.labParts.length == newLabParts.length) {
            return sendError('Lab part ' + req.partName + ' not found');
          }
          labdb.updateHomeLab(home.name, lab, newLabParts, function(e) {
            if (e) return sendError('Failed to update home lab', e);
          });
          _.each(home.socks, function(sock) {
            sock.updateLabParts(lab, newLabParts);
          });
        });
        break;
      case 'revertLabPart':
        if (!lab) return sendError('Lab has not been set');
        labdb.readLabPart(lab, req.partName, function(e, src) {
          if (e) return sendError('Failed to read lab part for lab ' +
                                  lab + ' part ' + req.partName, e);
          labdb.populateLabPart(
            home.name, lab, req.partName, src, true, function(e) {
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
        cursor.part = req.part;
        cursor.row = req.row;
        cursor.col = req.col;
        _.each(home.socks, function(sock) {
          if (sock != sockExports) sock.updateCursor(cursor);
        });
        break;
      case 'getCursors':
        _.each(home.socks, function(sock) {
          if (sock != sockExports) sockExports.updateCursor(sock.getCursor());
        });
        break;
      }
    });

    sock.on('close', function() {
      util.log('labserver #' + id + ' closed');
      javaRunner.stop();
      javaRunner.cleanup();
      removeFromHome();
    });

    sock.on('error', function(reason, errorCode) {
      util.log('labserver #' + id + ' error ' + errorCode + ': ' + reason);
    });

    sockExports.updateHomes();
    labdb.listLabs(function(e, labs) {
      if (e) return sendError('Failed to list labs');
      sockExports.updateLabs(labs);
    });
  });
}

