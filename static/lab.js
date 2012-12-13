angular.module('JavaLabModule', ['ngSanitize']).
  filter('highlightSubstring', function() {
    return function(input, search) {
      if (!search || search.length == 0) return input;
      var match = input.match(search);
      if (!match) return input;
      return (input.substring(0, match.index) +
              '<b>' +
              input.substring(match.index, match.index + match[0].length) +
              '</b>' +
              input.substring(match.index + match[0].length));
    }
  });

function LabCtrl($scope) {
  if (ace.require) {
    Range = ace.require('ace/range').Range;
  } else {
    Range = require('ace/range').Range;
  }

  $scope.user = '';
  $scope.home = '';
  $scope.homes = [];
  $scope.lab = 'scratch';
  $scope.labs = [];
  $scope.servermsg = 'disconnected';
  $scope.cursors = {};
  $scope.recentlyCreatedParts = [];

  var socket = new WebSocket('ws://' + document.location.host + '/labserver');
  socket.onopen = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = 'idle';
    });
  }
  socket.onmessage = function(event) {
    $scope.$apply(function() {
      var r = JSON.parse(event.data);
      switch (r.type) {
      case 'error':
        console.log(r.text);
        break;
      case 'state':
        $scope.servermsg = r.state;
        if (r.state == 'run') {
          clearTerm();
          $('#footertabs a[href="#output-tab"]').tab('show');
          $scope.errors = [];
          $scope.selectedError = null
        }
        break;
      case 'update':
        if (r.homes) {
          $scope.homes = _.sortBy(r.homes,
                                  function(home) { return -home.users; });
        } else if (r.labs) {
          $scope.labs = r.labs;
          if (!$scope.lab) {
            $scope.lab = $scope.labs[0] || null;
          }
        } else if (r.labParts) {
          var serverUnknownParts = [];
          _.each($scope.recentlyCreatedParts, function(part) {
            if (!_.find(r.labParts,
                        function(p) { return p.name == part.name; })) {
              serverUnknownParts.push(part);
            }
          });
          $scope.recentlyCreatedParts =
            _.intersection($scope.recentlyCreatedParts, serverUnknownParts);
          $scope.parts = r.labParts.concat(serverUnknownParts);
          if ($scope.activePart) {
            var activePart = _.find($scope.parts, function(part) {
              return part.name == $scope.activePart;
            });
            if (activePart) {
              $scope.switchPart(activePart);
            } else {
              $scope.switchPart($scope.parts[0] || null);
            }
          } else if ($scope.parts.length > 0) {
            $scope.switchPart($scope.parts[0]);
          }
        } else if (r.cursor) {
          var cursor = r.cursor;
          if (cursor.id in $scope.cursors) {
            $scope.editor.session.removeMarker(
              $scope.cursors[cursor.id].marker);
          }
          if (cursor.part == $scope.activePart &&
              cursor.row != undefined && cursor.col != undefined) {
            $scope.cursors[cursor.id] = {
              row: cursor.row, col: cursor.col,
              marker: $scope.editor.session.addMarker(
                new Range(cursor.row, cursor.col, cursor.row, cursor.col + 1),
                'shareCursor' + (cursor.id % 10),
                'line',
                true)};
          } else {
            delete $scope.cursors[cursor.id];
          }
        }
        break;
      case 'compileErrors':
        $scope.errors = r.compileErrors;
        $scope.selectedError = $scope.errors[0] || null;
        $('#footertabs a[href="#errors-tab"]').tab('show');
        $scope.onErrorSelect();
        break;
      case 'stdout':
        termStdout(r.stdout);
        break;
      }
    });
  }
  socket.onerror = socket.onclose = function(event) {
    console.log(event);
    $scope.$apply(function() {
      $scope.servermsg = 'disconnected';
      $scope.editor.setReadOnly(true);
    });
  }

  $scope.errors = [];
  $scope.selectedError = null;
  $scope.onErrorSelect = function() {
    if ($scope.selectedError) {
      $scope.editor.gotoLine($scope.selectedError.line,
                             $scope.selectedError.col);
    }
  }

  $scope.newPartNameChanged = function() {
    $scope.newPartForm.$invalid = 
      !$scope.newPartPattern.exec($scope.newPartName) ||
      _.contains($scope.parts, $scope.newPartName);
  }

  $scope.newPartPattern = /^[A-Za-z0-9]*$/;
  $scope.parts = [];
  $scope.activePart = null;

  var shareConnection = new sharejs.Connection(
    'ws://' + document.location.host + '/shareserver');
  var openDoc = null;
  $scope.switchPart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    if (part && $scope.activePart && $scope.activePart == part.name) {
      return;
    }

    $scope.errors = [];
    $scope.selectedError = null;
    if (part) {
      $scope.activePart = part.name;
    } else {
      $scope.activePart = null;
      socket.send(JSON.stringify({type: 'setLabPart', labPart: ''}));
    }

    if (openDoc) {
      openDoc.detach_ace();
      // TODO: closing sharejs docs prevents them from ever being re-opened
      // revisit closing docs here if sharejs is fixed
      openDoc = null;
      $scope.editor.setReadOnly(true);
      _.each($scope.cursors, function(cursor) {
        $scope.editor.session.removeMarker(cursor.marker);
      });
      $scope.cursors = {};
    }

    if (part != null) {
      $scope.editor.setValue('Loading...');
      shareConnection.open(
        $scope.home + ':' + $scope.lab + ':' + $scope.activePart,
        'text',
        function(e, doc) {
          if (e) return console.log(e);
          if (doc.state != 'open')
            console.log('Opened doc ' + doc.name + ' has state ' + doc.state);
          if (part.name != $scope.activePart) {
            // another doc became active while this doc was opening
            return;
          }
          socket.send(JSON.stringify({type: 'setLabPart', labPart: part.name}));
          openDoc = doc;
          doc.attach_ace($scope.editor);
          $scope.editor.gotoLine(1, 0, false);
          $scope.editor.scrollToRow(0);
          $scope.editor.setReadOnly(false);

          // We need to delay this because the Ace change handler adds
          // the new undo information asynchronously. This is a racy
          // solution but practically should work fine.
          window.setTimeout(function() {
            $scope.editor.getSession().getUndoManager().reset();
          }, 5);

          if (socket.readyState == 1) {
            socket.send(JSON.stringify({type: 'getCursors'}));
          }

          doc.on('remoteop', function(op) {
            // We need to delay this because the Ace change handler adds
            // the new undo information asynchronously. This is a racy
            // solution but practically should work fine.
            window.setTimeout(function() {
              $scope.editor.getSession().getUndoManager().reset();
            }, 5);

            // This is needed because the cursor change may arrive
            // before the ShareJS operation.
            // TODO: find a more efficient solution
            _.each($scope.cursors, function(cursor, id) {
              $scope.editor.session.removeMarker(cursor.marker);
              cursor.marker = $scope.editor.session.addMarker(
                new Range(cursor.row, cursor.col, cursor.row, cursor.col + 1),
                'shareCursor' + (id % 10),
                'line',
                true);
            });
          });
        });
    } else {
      $scope.editor.setValue('No part selected');
      $scope.editor.getSession().getUndoManager().reset();
    }
  }

  $scope.removePart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'deleteLabPart', partName: part.name}));
    var i = $scope.parts.indexOf(part);
    $scope.parts.splice(i, 1);
    if ($scope.activePart == part.name) {
      if (i == $scope.parts.length) i--;
      $scope.switchPart($scope.parts.length == 0 ? null : $scope.parts[i]);
    }
    $scope.recentlyCreatedParts = _.without($scope.recentlyCreatedParts, part);
  }

  $scope.revertPart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'revertLabPart', partName: part.name}));
  }

  $scope.newPart = function() {
    $scope.newPartNameChanged();
    if (!$scope.user || socket.readyState != 1) return;
    if ($scope.newPartForm.$invalid || !$scope.newPartName)
      return;

    if (_.find($scope.parts, function(part) {
      return part.name == $scope.newPartName;
    })) {
      $scope.newPartName = '';
      return;
    }

    var newPart = {name: $scope.newPartName, predefined: false};
    $scope.newPartName = '';
    $scope.parts.push(newPart);
    $scope.recentlyCreatedParts.push(newPart);
    $scope.switchPart(newPart);
    socket.send(JSON.stringify({type: 'addLabPart', partName: newPart.name}));
  }

  $scope.login = function() {
    if (!$scope.user) return;
    $('#loginModal').modal('hide');
  }

  $('#loginModal').on('hidden', function() {
    $scope.$apply(function() {
      if (!$scope.user) return;
      $scope.home = $scope.user;
      if (!_.find($scope.homes,
                  function(home) { return home.name == $scope.home; })) {
        $scope.homes.push({name: $scope.home, users: 1});
      }
      socket.send(JSON.stringify({type: 'setUser', user: $scope.user}));
      socket.send(JSON.stringify({type: 'setHome', home: $scope.home}));
      socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
      $scope.switchPart(null);
    });
  });

  $scope.switchLab = function(labName) {
    if ($scope.lab == labName) return;
    $scope.lab = labName;
    $scope.switchPart(null);
    socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
  }

  $scope.newLab = function() {
    // TODO: name validation
    $('#labDropdown').dropdown('toggle');
    $scope.lab = $scope.newLabName;
    $scope.labs.push($scope.lab);
    $scope.newLabName = '';
    $scope.switchPart(null);
    socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
  }

  $scope.matchesNewHome = function(home) {
    if (!$scope.newHomeName) return true;
    return home.name.indexOf($scope.newHomeName) != -1;
  }

  $scope.switchHome = function(homeName) {
    if ($scope.home == homeName) return;
    $scope.home = homeName;
    $scope.newHomeName = '';
    socket.send(JSON.stringify({type: 'setHome', home: $scope.home}));
    $scope.switchPart(null);
  }

  var newHomePattern = /^[A-Za-z0-9]*$/;
  $scope.newHomeNameChanged = function() {
    $scope.newHomeForm.$invalid = !newHomePattern.exec($scope.newHomeName);
    var input = $('#homeNameInput')[0];
    if (input.value.length == 0) return;
    if (($.browser.mozilla && input.selectionStart == input.value.length) ||
        ($.browser.webkit && input.selectionStart == input.value.length - 1)) {
      var closestHome = _.find($scope.homes, function(home) {
        return home.name.substring(0, input.value.length) == input.value;
      });
      if (closestHome) {
        var name = closestHome.name;
        var len = input.value.length;
        window.setTimeout(function() {
          input.value = name;
          input.selectionStart = len;
          input.selectionEnd = input.value.length;
        }, 0);
      }
    }
  }

  $('#homeNameInput').keydown(function(event) {
    if (event.which == 13) {
      if (this.selectionEnd - this.selectionStart > 0) {
        this.selectionStart = this.value.length;
        this.selectionEnd = this.value.length;
        event.preventDefault();
        var value = this.value;
        $scope.$apply(function() {
          $scope.newHomeName = value;
        });
      }
    }
    if (event.which == 8) {
      if (this.selectionEnd == this.value.length &&
          this.selectionStart != this.selectionEnd &&
          this.selectionStart > 0) {
        event.preventDefault();
        var value = this.value.substring(0, this.selectionStart - 1);
        this.value = value;
        $scope.$apply(function() {
          $scope.newHomeName = value;
        });
      } else if (this.selectionEnd == this.value.length &&
                 this.selectionStart == this.selectionEnd) {
        event.preventDefault();
        var value = this.value.substring(0, this.selectionStart - 1);
        $scope.$apply(function() {
          $scope.newHomeName = value;
        });
      }
    }
  });

  $scope.newHome = function() {
    if ($scope.newHomeForm.$invalid) return;
    $('#homeDropdown').dropdown('toggle');
    $scope.home = $scope.newHomeName;
    $scope.homes.push({name: $scope.home, users: 1});
    $scope.newHomeName = '';
    socket.send(JSON.stringify({type: 'setHome', home: $scope.home}));
    $scope.switchPart(null);
  }

  $scope.run = function() {
    if (!$scope.user || socket.readyState != 1) return;
    var src = $scope.editor.getValue();
    socket.send(JSON.stringify({type: 'compileRun', src: src}));
  }

  $scope.stop = function() {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'stop'}));
  }

  $scope.initEditor = function() {
    $scope.editor = ace.edit('editor');
    $scope.editor.setTheme('ace/theme/chrome');
    $scope.editor.getSession().setMode('ace/mode/java');
    $scope.editor.setPrintMarginColumn(100);
    $scope.editor.getSession().setUseSoftTabs(true);
    $scope.editor.getSession().setTabSize(2);
    $scope.editor.setValue('No part loaded');
    $scope.editor.setReadOnly(true);

    function uploadCursor() {
      if (!$scope.user || !$scope.lab || !$scope.activePart ||
          socket.readyState != 1) {
        return;
      }
      var message = {type: 'setCursor', part: $scope.activePart};
      var pos = $scope.editor.getCursorPosition();
      message.row = pos.row;
      message.col = pos.column;
      socket.send(JSON.stringify(message));
    }
    $scope.editor.on('changeSelection', uploadCursor);
  }

  var termStdinStart = 0;
  function clearTerm() {
    var term = $('#terminal')[0];
    term.value = '';
    termStdinStart = 0;
  }
  function termStdout(stdoutData) {
    var term = $('#terminal')[0];
    var stdinData = '';
    if (term.value.length > termStdinStart) {
      stdinData = term.value.substr(termStdinStart);
      term.value = term.value.substring(0, termStdinStart);
    }
    term.value += stdoutData;
    termStdinStart += stdoutData.length;
    if (stdinData) {
      term.value += stdinData;
    }
    term.scrollTop = term.scrollHeight;
  }
  $scope.initTerminal = function() {
    clearTerm();
    var term = $('#terminal')[0];
    $('#terminal').keydown(function(event) {
      handlers = {
        8: function() {  // backspace
          if (term.selectionStart <= termStdinStart) {
            event.preventDefault();
          }
        },
        46: function() {  // delete
          if (term.selectionStart < termStdinStart) {
            event.preventDefault();
          }
        },
        13: function() {  // newline
          if (term.selectionStart == term.value.length) {
            term.value += '\n';
            var stdinData = term.value.substr(termStdinStart);
            termStdinStart = term.value.length;
            if (socket.readyState == 1) {
              socket.send(JSON.stringify({type: 'stdin', stdin: stdinData}));
            }
            term.scrollTop = term.scrollHeight;
          }
          event.preventDefault();
        }
      };
      if (event.which in handlers) {
        if ($scope.servermsg != 'run') {
          event.preventDefault();
        } else {
          handlers[event.which]();
        }
      }
    });
    $('#terminal').keypress(function(event) {
      if (event.which > 31 && event.which < 127) {
        if ($scope.servermsg != 'run' ||
            term.selectionStart < termStdinStart) {
          event.preventDefault();
        }
      }
    });
    $('#terminal').bind('cut', function(event) {
      if (term.selectionStart < termStdinStart)
        event.preventDefault();
    });
    $('#terminal').bind('paste', function(event) {
      if (term.selectionStart < termStdinStart)
        event.preventDefault();
    });
  }

  $(window).load(function() {
    // allow user to resize tabs
    (function() {
      var startY = null;
      $('#footerhandle').mousedown(function(event) {
        event.preventDefault();
        startY = event.clientY;
        $('html').addClass('ns-resize');
      });
      $(window).mousemove(function(event) {
        if (startY) {
          var delta = startY - event.clientY;
          if (delta < 0 && $('#footer').height() < 150) return;
          if (delta > 0 && $('#content').height() < 150) return;
          $('#footer').css('height', '+=' + delta);
          $('#content').css('bottom', '+=' + delta);
          startY = event.clientY;
          $scope.editor.resize(true);
        }
      });
      $(window).mouseup(function(event) {
        if (startY) {
          startY = null;
          $('html').removeClass('ns-resize');
        }
      });
    }());

    // fix bootstrap dropdown handler to allow text input
    var clearMenus;
    var clickEvents = $._data($('html')[0], 'events').click;
    for (var i = 0; i < clickEvents.length; i++) {
      if (clickEvents[i].namespace == 'data-api.dropdown') {
        clearMenus = clickEvents[i].handler;
        clickEvents.splice(i, 1);
        break;
      }
    }
    var touchEvents = $._data($('html')[0], 'events').touchstart;
    for (var i = 0; i < touchEvents.length; i++) {
      if (touchEvents[i].namespace == 'data-api.dropdown') {
        touchEvents.splice(i, 1);
        break;
      }
    }
    $('#labDropdown').dropdown();
    $('#homeDropdown').dropdown();
    var clickEvents = $._data($('html')[0], 'events').click;
    for (var i = 0; i < clickEvents.length;) {
      if (clickEvents[i].namespace == 'data-api.dropdown') {
        clickEvents.splice(i, 1);
      } else {
        ++i;
      }
    }    
    $('html').on(
      'click.dropdown.data-api touchstart.dropdown.data-api', function(e) {
        var src = e.srcElement || e.target;
        if (src &&
            (src.id == 'labNameInput' ||
             src.id == 'homeNameInput')) {
          return;
        }
        clearMenus();
      });

    // show the login modal dialog on startup
    $('#loginModal').modal();
  });
}