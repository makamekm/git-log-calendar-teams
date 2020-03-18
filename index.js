const GitRepository = require('./git-tools');
const YAML = require('yaml');
const path = require('path');
const fs = {
  ...require('fs'),
  ...require('fs-extra')
};
const d3Node = require('d3-node');

// Collect Stats
const DIVIDER = '-_-';
const NULL_COLOR = '#ebedf0';
const DAY_MILLISECONDS = 86400000;
const STATS_FILE_POSTFIX = '.stats.json';

// Calendar Report
const CELL_SIZE = 15;
const YEAR_HEIGHT = CELL_SIZE * 7;
const MARGIN_TOP = CELL_SIZE * 0.5;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 10;
const WEEKS_IN_A_YEAR = 53;

// Export API
module.exports = {
  collect,
  clean,
  report
};

// Load Config from YAML (Required)
async function getConfig() {
  const configPath = path.resolve(process.env.GIT_LOG_CONFIG_PATH || './git-log-config.yml');
  if (fs.existsSync(configPath)) {
    const file = fs.readFileSync(configPath, 'utf8');
    return YAML.parse(file);
  } else {
    const p = `\\\\rjfs2\\corpshare$\\GitStats\\git-log-config.yml`;
    if (!fs.existsSync(p)) {
      throw Error('Config file has not been found: git-log-config.yml');
    }
    const file = fs.readFileSync(p, 'utf8');
    return YAML.parse(file);
  }
}

// Format repository name to a file name
function getRepositoryName(repository) {
  return repository.name.replace(/\W+/g, '-').toLowerCase();
}

// Collect users into invert groups (others)
function collectUnusedUsers(config) {
  let usedUsers = [];
  for (let team of config.teams) {
    team.users = team.users || [];
    if (team.invert) {
      team.users = usedUsers;
    } else {
      usedUsers = [...usedUsers, ...team.users];
    }
  }
  return usedUsers;
}

// Get default clone branch name
function getBranchName(repository, config) {
  return repository.branch || config.branch || 'master';
}

// Get all stats from a folder and return them with obsolete stats files
function readStatsFolder(config) {
  let toRemove = [];
  const fileMap = {};
  for (let file of fs.readdirSync(config.statsDir)) {
    if (file.includes(STATS_FILE_POSTFIX)) {
      const line = file.split('.')[0];
      let [repositoryName, timestamp] = line.split(DIVIDER);
      timestamp = Number.parseInt(timestamp, 10);
      const fileKey = repositoryName;
      if (!fileMap[fileKey] || fileMap[fileKey].timestamp < timestamp) {
        if (fileMap[fileKey]) {
          toRemove.push(path.resolve(config.statsDir, fileMap[fileKey].file));
        }
        fileMap[fileKey] = {
          repositoryName,
          file,
          timestamp
        };
      } else {
        toRemove.push(path.resolve(config.statsDir, file));
      }
    }
  }
  return { fileMap, toRemove };
}

// Remove all obsolete stats by checking timestamp
async function clean() {
  const config = await getConfig();
  const { toRemove } = readStatsFolder(config);
  for (let file of toRemove) {
    fs.removeSync(file);
  }
}

// Clone or update git repository
async function loadRepository(repository, config) {
  const tmpDir = path.resolve(config.tmpDir);
  fs.ensureDirSync(tmpDir);

  const repositoryName = getRepositoryName(repository);
  const repositoryPath = path.resolve(tmpDir, repositoryName);
  let pathExist = fs.existsSync(repositoryPath);
  let gitRepository = new GitRepository(repositoryPath);

  if (config.cleanTmp || repository.cleanTmp || (pathExist && !(await gitRepository.isGitRepository()))) {
    fs.removeSync(repositoryPath);
    pathExist = false;
  }

  if (!pathExist) {
    fs.ensureDirSync(repositoryPath);
    gitRepository = await GitRepository.clone({
      repo: repository.url,
      dir: repositoryPath,
      branch: getBranchName(repository, config)
    });
  } else {
    await gitRepository.checkout(getBranchName(repository, config));
  }

  return gitRepository;
}

// Collect  stats from repositories and save them into a stats folder
async function collect() {
  const config = await getConfig();
  fs.ensureDirSync(config.statsDir);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      const gitRepository = await loadRepository(repository, config);
      const authors = await gitRepository.authors();
      if (authors.length > 0) {
        const repositoryAuthorsFileName = `${repositoryName}${DIVIDER}${Date.now().toString()}${STATS_FILE_POSTFIX}`;
        fs.writeFileSync(path.resolve(config.statsDir, repositoryAuthorsFileName), JSON.stringify(authors, null, 4));
      }
    } catch (err) {
      if (process.env.DEBUG || config.debug) {
        console.error(err);
      }
    }
  }
}

// Check if the pair of email & name belongs to a reposoroty & team, but excluding the specifyed occurrences
function isAuthorBelongToRepositoryAndTeam(repository, team, users, email, name) {
  name = name.toLowerCase();
  email = email.toLowerCase();
  const user = users.find(u => u.associations.includes(email) || u.associations.includes(name));
  const excludeTeam = team.exclude && (team.exclude.includes(name) || team.exclude.includes(email));
  const excludeRepository = repository.exclude && (repository.exclude.includes(name) || repository.exclude.includes(email));
  if (user) {
    const includesTeam = team.users.includes(user.name);
    return (team.invert ? !includesTeam : includesTeam) && (!team.exclude || !excludeTeam) && (!repository.exclude || !excludeRepository);
  } else {
    const includesTeam = team.users.includes(name) || team.users.includes(email);
    return (team.invert ? !includesTeam : includesTeam) && (!team.exclude || !excludeTeam) && (!repository.exclude || !excludeRepository);
  }
}

// Generate calendar reports from teams (reportCalendarTeam)
async function report() {
  const config = await getConfig();
  collectUnusedUsers(config);

  const dates = {};
  for (let team of config.teams) {
    dates[team.name] = {};
  }

  const { fileMap } = readStatsFolder(config);

  for (let team of config.teams) {
    for (let repository of config.repositories) {
      const repositoryName = getRepositoryName(repository);
      if (fileMap[repositoryName]) {
        const authors = JSON.parse(fs.readFileSync(path.resolve(config.statsDir, fileMap[repositoryName].file), 'utf8'));
        for (let author of authors) {
          if (isAuthorBelongToRepositoryAndTeam(repository, team, config.users, author.email, author.name)) {
            for (let key in author.map) {
              dates[team.name][key] = (dates[team.name][key] || 0) + author.map[key].linesChanged;
            }
          }
        }
      }
    }
  }

  for (let report of config.reportCalendarTeam) {
    const comparedData = getComparedData(report, dates);
    generateTeamCalendarReport(dates[report.team], report, comparedData, config);
  }
}

function getComparedData(report, dates) {
  const comparedData = [];
  for (const compareTeamName of report.compareTeams || []) {
    for (const key in dates[compareTeamName]) {
      comparedData.push(dates[compareTeamName][key]);
    }
  }
  return comparedData;
}

function normalizeData(dates) {
  let data = [];

  for (let key in dates) {
    data.push({ Date: key, Value: dates[key] });
  }

  data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  data = data.reduce((acc, value) => {
    const lastDate = new Date(value.Date);
    const firstDate = acc[acc.length - 1] && new Date(acc[acc.length - 1].Date);
    if (firstDate) {
      const emptyDaysCount = lastDate / DAY_MILLISECONDS - firstDate / DAY_MILLISECONDS + 1;
      const emptyDays = [...Array(emptyDaysCount).keys()];
      const emptyDates = emptyDays.map(k => {
        const date = new Date(firstDate);
        date.setDate(date.getDate() + k + 1);
        return date;
      });
      emptyDates.forEach(date => {
        acc.push({ Date: date, Value: 0 });
      });
    }
    acc.push(value);
    return acc;
  }, []);

  return data;
}

function normalizeDataWithD3(data) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  let minYear = Infinity;
  let maxYear = 0;

  const checkYear = date => {
    const year = date.getFullYear();

    if (year > maxYear) {
      maxYear = year;
    }

    if (year < minYear) {
      minYear = year;
    }
  };

  const dateValues = data.map(dv => {
    const date = new Date(dv.Date);
    checkYear(date);
    return {
      date: d3.timeDay(date),
      value: Number(dv.Value)
    };
  });

  return {
    dateValues,
    minYear,
    maxYear
  };
}

function normalizeYearsWithD3(dateValues, compared) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  const years = d3
    .nest()
    .key(d => d.date.getUTCFullYear())
    .entries(dateValues)
    .reverse();

  const values = dateValues.map(c => c.value);
  let maxValue = d3.max(values);
  const minValue = 0;

  if (compared.length > 0) {
    const maxValueCompared = d3.max(compared);
    if (maxValueCompared > maxValue) {
      maxValue = maxValueCompared;
    }
  }

  return {
    years,
    values,
    maxValue,
    minValue
  };
}

function normalizeDataForCalendarReport(dates, compared) {
  const data = normalizeData(dates);
  const { dateValues, minYear, maxYear } = normalizeDataWithD3(data);
  const { years, maxValue, minValue } = normalizeYearsWithD3(dateValues, compared);
  return {
    years,
    minYear,
    maxYear,
    maxValue,
    minValue
  };
}

// Generate calendar report
function generateTeamCalendarReport(dates, report, compared, config) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  const { years, minYear, maxYear, maxValue, minValue } = normalizeDataForCalendarReport(dates, compared);

  if (maxYear === 0) {
    fs.removeSync(path.resolve(report.output));
    return;
  }

  const yearGap = Math.abs(maxYear - minYear);
  const [width, height] = [MARGIN_LEFT + CELL_SIZE * (WEEKS_IN_A_YEAR + 1) + MARGIN_RIGHT, YEAR_HEIGHT * (yearGap + 1) + 2 * MARGIN_TOP];
  const svg = d3n.createSVG(width, height);

  const group = svg.append('g');

  const year = group
    .selectAll('g')
    .data(years)
    .join('g')
    .attr('transform', (_, i) => `translate(${MARGIN_LEFT}, ${YEAR_HEIGHT * i + MARGIN_TOP})`);

  year
    .append('text')
    .attr('x', -5)
    .attr('y', -30)
    .attr('text-anchor', 'end')
    .attr('font-size', 16)
    .attr('font-weight', 550)
    .attr('font-family', 'Arial')
    .attr('transform', 'rotate(270)')
    .text(d => d.key);

  const formatDay = d => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d.getUTCDay()];
  const countDay = d => d.getUTCDay();
  const timeWeek = d3.utcSunday;
  const formatDate = d3.utcFormat('%x');
  const colorFn = d3.scaleSequential(d3[config.colorFn || 'interpolateGreens']).domain([Math.floor(minValue), Math.ceil(maxValue)]);

  year
    .append('g')
    .attr('text-anchor', 'end')
    .selectAll('text')
    .data(d3.range(7).map(i => new Date(1995, 0, i)))
    .join('text')
    .attr('x', -5)
    .attr('y', d => (countDay(d) + 0.5) * CELL_SIZE)
    .attr('dy', '0.31em')
    .attr('font-size', 12)
    .text(formatDay);

  year
    .append('g')
    .selectAll('rect')
    .data(d => d.values)
    .join('rect')
    .attr('width', CELL_SIZE - (config.padding != null ? config.padding : 3.5))
    .attr('height', CELL_SIZE - (config.padding != null ? config.padding : 3.5))
    .attr('x', d => timeWeek.count(d3.utcYear(d.date), d.date) * CELL_SIZE + 10)
    .attr('y', d => countDay(d.date) * CELL_SIZE + 0.5)
    .attr('fill', d => {
      if (d.value < 1) {
        return config.zeroColor || NULL_COLOR;
      }
      return colorFn(d.value);
    })
    .append('title')
    .text(d => `${formatDate(d.date)}: ${d.value.toFixed(2)}`);

  fs.writeFileSync(path.resolve(report.output), d3n.svgString());
}
