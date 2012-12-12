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
        homes[homeName] = {
          name: homeName,
          socks: [],
          labs: {}
        };
      }
    });
  });
});

exports.attach = function(server) {
  var options = {server: server, path: '/labserver'};
  var wss = new ws.Server(options);
  wss.on('connection', function(sock) {
    var id = nextId++;
    util.log('labserver ' + id + ' connected');

    var user = '';
    var home = null;
    var lab = '';
    var labPart = '';
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
      'getLab': function() {
        return lab;
      },
      'getLabPart': function() {
        return labPart;
      },
      'getUser': function() {
        return user;
      },
      'setCursorId': function(id) {
        cursor.id = id;
      },
      'updateCursor': function(cursor) {
        if (sock.readyState != ws.OPEN) return;
        sock.send(JSON.stringify({type: 'update', cursor: cursor}));
      },
      'updateHomes': function() {
        if (sock.readyState != ws.OPEN) return;
        sock.send(JSON.stringify(
          {type: 'update', homes: _.map(homes, function(home) {
            return { name: home.name,
                     users: home.socks.length };
          })}));
      },
      'updateLabs': function(labs) {
        if (sock.readyState != ws.OPEN) return;
        sock.send(JSON.stringify({type: 'update', labs: labs}));
      },
      'updateLabParts': function(labToUpdate, labParts) {
        if (sock.readyState != ws.OPEN) return;
        if (lab != labToUpdate) return;
        sock.send(JSON.stringify({type: 'update', labParts: labParts}));
      }
    };

    function sendError(errorText, e) {
      if (sock.readyState != ws.OPEN) return;
      if (e) errorText += ': ' + e;
      sock.send(JSON.stringify({type: 'error', text: errorText}));
    }
 
    function addToHome(homeName) {
      if (!(homeName in homes)) {
        homes[homeName] = {
          name: homeName,
          socks: [],
          labs: {}
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

    function updateHomeLabParts(labName) {
      if (!(labName in home.labs)) {
        labdb.getOrCreateHomeLab(home.name, labName, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          if (!(labName in home.labs)) {
            home.labs[labName] = labInfo;
          }
          setLabPartUsers();
        });
      } else {
        setLabPartUsers();
      }

      function setLabPartUsers() {
        var labParts = home.labs[labName].labParts;
        _.each(labParts, function(part) {
          part.users = [];
          _.each(home.socks, function(sock) {
            if (sock.getLab() == labName && sock.getLabPart() == part.name) {
              part.users.push({user: sock.getUser(), id: sock.getCursor().id});
            }
          });
        });
        _.each(home.socks, function(sock) {
          sock.updateLabParts(labName, labParts);
        });
      }
    }

    sock.on('message', function(message) {
      var req;
      try {
        req = JSON.parse(message);
      } catch (e) {
        return sendError('Failed to parse request', e);
      }

      if (!home && req.type != 'setHome' && req.type != 'setUser') {
        return sendError('Home has not been set: ' + message);
      }

      switch (req.type) {
      case 'setUser':
        util.log('labserver ' + id + ' sets user to ' + req.user);
        user = req.user;
        break;
      case 'setHome':
        util.log('labserver ' + id + ' sets home to ' + req.home);
        removeFromHome();
        addToHome(req.home);
        if (lab) updateHomeLabParts(lab);
        break;
      case 'setLab':
        util.log('labserver ' + id + ' sets lab to ' + req.lab);
        lab = req.lab;
        if (lab) updateHomeLabParts(lab);
        break;
      case 'setLabPart':
        util.log('labserver ' + id + ' sets lab part to ' + req.labPart);
        labPart = req.labPart;
        if (lab) updateHomeLabParts(lab);
        break;
      case 'addLabPart':
        util.log('labserver ' + id + ' creates lab part ' + req.partName);
        if (!lab) return sendError('Lab has not been set');
        var startLab = lab;
        labdb.getOrCreateHomeLab(home.name, startLab, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          labInfo.labParts.push({name: req.partName, predefined: false});
          labdb.updateHomeLab(home.name, startLab, labInfo.labParts, function(e) {
            if (e) return sendError('Failed to update home lab', e);
          });
          home.labs[startLab] = labInfo;
          var mainBoilerplate = MAIN_BOILERPLATE.replace('Main', req.partName);
          labdb.populateLabPart(
            home.name, startLab, req.partName, mainBoilerplate, false,
            function(e) {
              if (e) return sendError('Failed to populate new lab part', e);
            });
          updateHomeLabParts(startLab);
        });
        break;
      case 'deleteLabPart':
        util.log('labserver ' + id + ' deletes lab part ' + req.partName);
        if (!lab) return sendError('Lab has not been set');
        var startLab = lab;
        labdb.getOrCreateHomeLab(home.name, startLab, function(e, labInfo) {
          if (e) return sendError('Failed to get home lab', e);
          var newLabParts = _.reject(labInfo.labParts, function(labPart) {
            return labPart.name == req.partName;
          });
          if (labInfo.labParts.length == newLabParts.length) {
            return sendError('Lab part ' + req.partName + ' not found');
          }
          labdb.updateHomeLab(home.name, startLab, newLabParts, function(e) {
            if (e) return sendError('Failed to update home lab', e);
          });
          home.labs[startLab].labParts = newLabParts;
          updateHomeLabParts(startLab);
        });
        break;
      case 'revertLabPart':
        util.log('labserver ' + id + ' reverts lab part ' + req.partName);
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
      util.log('labserver ' + id + ' closed');
      javaRunner.stop();
      javaRunner.cleanup();
      labPart = '';
      if (lab) updateHomeLabParts(lab);
      removeFromHome();
    });

    sock.on('error', function(reason, errorCode) {
      util.log('labserver ' + id + ' error ' + errorCode + ': ' + reason);
    });

    sockExports.updateHomes();
    labdb.listLabs(function(e, labs) {
      if (e) return sendError('Failed to list labs');
      sockExports.updateLabs(labs);
    });
  });
}

